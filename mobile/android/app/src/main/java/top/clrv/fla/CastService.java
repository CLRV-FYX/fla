package top.clrv.fla;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * 整屏采集 → JPEG → WebSocket 二进制帧 (首字节 'C') 发给电脑。
 * 先试局域网直连 (ws://电脑IP:8308), 1.5 秒连不上再走服务器中继 (wss://线路/api/remote/hub)。
 * 流控: 电脑显示完回 {"type":"ack","ch":"C"} 才发下一帧 → 不堆积, 延迟最低。
 */
public class CastService extends Service {
    interface Listener { void on(String s); }
    static Listener listener;

    static final int MAX_SIDE = 1280;
    static final int QUALITY = 55;

    MediaProjection projection;
    VirtualDisplay display;
    ImageReader reader;
    HandlerThread thread;
    Handler worker;
    WebSocket ws;
    volatile boolean connected, stopped;
    volatile long pendingAt;
    String sid, code, server;
    ArrayList<String> lan;
    int lanIdx;
    boolean viaLan;
    final OkHttpClient http = new OkHttpClient.Builder()
            .connectTimeout(1500, TimeUnit.MILLISECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(15, TimeUnit.SECONDS).build();

    void say(String s) { if (listener != null) listener.on(s); }

    @Override
    public IBinder onBind(Intent i) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        startAsForeground();
        sid = intent.getStringExtra("sid");
        code = intent.getStringExtra("code");
        server = intent.getStringExtra("server");
        lan = intent.getStringArrayListExtra("lan");
        if (lan == null) lan = new ArrayList<>();
        int res = intent.getIntExtra("result", 0);
        Intent data = intent.getParcelableExtra("data");
        MediaProjectionManager m = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = m.getMediaProjection(res, data);
        if (projection == null) { say("无法获取屏幕录制权限"); stopSelf(); return START_NOT_STICKY; }
        thread = new HandlerThread("cast");
        thread.start();
        worker = new Handler(thread.getLooper());
        projection.registerCallback(new MediaProjection.Callback() {
            @Override public void onStop() { stopSelf(); }
        }, worker);
        startCapture();
        lanIdx = 0;
        connect();
        return START_NOT_STICKY;
    }

    void startAsForeground() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26)
            nm.createNotificationChannel(new NotificationChannel("cast", "投屏", NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, "cast") : new Notification.Builder(this);
        Notification n = b.setContentTitle("FLA 正在投屏到电脑").setContentText("点此返回 App 停止投屏")
                .setSmallIcon(android.R.drawable.ic_menu_share).setContentIntent(open).setOngoing(true).build();
        if (Build.VERSION.SDK_INT >= 29) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
        else startForeground(1, n);
    }

    void startCapture() {
        DisplayMetrics dm = new DisplayMetrics();
        ((WindowManager) getSystemService(WINDOW_SERVICE)).getDefaultDisplay().getRealMetrics(dm);
        float s = Math.min(1f, (float) MAX_SIDE / Math.max(dm.widthPixels, dm.heightPixels));
        int w = Math.round(dm.widthPixels * s) & ~1, h = Math.round(dm.heightPixels * s) & ~1;
        reader = ImageReader.newInstance(w, h, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::onImage, worker);
        display = projection.createVirtualDisplay("fla-cast", w, h, dm.densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, worker);
    }

    void onImage(ImageReader r) {
        Image img = null;
        try {
            img = r.acquireLatestImage();
            if (img == null) return;
            if (!connected || stopped) return;
            if (pendingAt != 0 && System.currentTimeMillis() - pendingAt < 1500) return;   // 等电脑 ack
            Image.Plane p = img.getPlanes()[0];
            int w = img.getWidth(), h = img.getHeight();
            int rowPad = p.getRowStride() - p.getPixelStride() * w;
            Bitmap bmp = Bitmap.createBitmap(w + rowPad / p.getPixelStride(), h, Bitmap.Config.ARGB_8888);
            ByteBuffer buf = p.getBuffer();
            bmp.copyPixelsFromBuffer(buf);
            if (rowPad != 0) { Bitmap c = Bitmap.createBitmap(bmp, 0, 0, w, h); bmp.recycle(); bmp = c; }
            ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
            out.write('C');
            bmp.compress(Bitmap.CompressFormat.JPEG, viaLan ? 70 : QUALITY, out);
            bmp.recycle();
            pendingAt = System.currentTimeMillis();
            ws.send(ByteString.of(out.toByteArray()));
        } catch (Exception ignored) {
        } finally {
            if (img != null) img.close();
        }
    }

    void connect() {
        if (stopped) return;
        String url;
        if (lanIdx < lan.size()) { url = lan.get(lanIdx); viaLan = true; }
        else {
            url = server.replace("https://", "wss://").replace("http://", "ws://") + "/api/remote/hub/" + sid + "?code=" + code + "&role=phone";
            viaLan = false;
        }
        say(viaLan ? "正在局域网直连电脑…" : "正在经服务器连接电脑…");
        ws = http.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket s, Response r) {
                connected = true; pendingAt = 0;
                s.send("{\"action\":\"cast_start\",\"data\":{\"source\":\"android\"}}");
                say(viaLan ? "投屏中（局域网直连，极速）" : "投屏中（服务器中转）");
            }
            @Override public void onMessage(WebSocket s, String t) {
                if (t.contains("\"ack\"") && t.contains("\"C\"")) pendingAt = 0;
            }
            @Override public void onFailure(WebSocket s, Throwable t, Response r) { retry(); }
            @Override public void onClosed(WebSocket s, int c, String reason) { retry(); }
        });
    }

    void retry() {
        boolean was = connected;
        connected = false;
        if (stopped) return;
        if (!was && lanIdx < lan.size()) { lanIdx++; worker.post(this::connect); return; }   // 下一个局域网地址 / 服务器
        say("连接断开，正在重连…");
        worker.postDelayed(() -> { lanIdx = 0; connect(); }, 2000);
    }

    @Override
    public void onDestroy() {
        stopped = true;
        try { if (ws != null) { ws.send("{\"action\":\"cast_stop\"}"); ws.close(1000, "bye"); } } catch (Exception ignored) { }
        if (display != null) display.release();
        if (reader != null) reader.close();
        if (projection != null) projection.stop();
        if (thread != null) thread.quitSafely();
        say("已停止投屏");
        super.onDestroy();
    }
}
