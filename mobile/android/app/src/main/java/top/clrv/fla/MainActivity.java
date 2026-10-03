package top.clrv.fla;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Vibrator;
import android.view.View;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

/**
 * FLA 手机端: WebView 外壳 + 原生整屏录制。
 *  - 首页 https://app.fla/home.html (内置 assets, 离线可用): 选线路 / 扫码 / 输配对码
 *  - 连接后加载 线路/cast.html (观看电脑·批注·翻页·摄像头投屏), 与网页版同步更新
 *  - window.FLA.startScreen() → MediaProjection 整屏 → CastService 推流到电脑
 */
public class MainActivity extends Activity {
    static final String HOME = "https://app.fla/home.html";
    static final String VERSION = "1.1.0";
    static final int REQ_CAPTURE = 7, REQ_CAM = 8, REQ_FILE = 9;

    WebView web;
    final Handler ui = new Handler(Looper.getMainLooper());
    String sid, code, server;
    ArrayList<String> lanUrls = new ArrayList<>();
    PermissionRequest pendingPerm;
    ValueCallback<Uri[]> fileCb;
    volatile String curUrl = HOME;
    boolean autoStart;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#0b0b0c"));
        w.setNavigationBarColor(Color.parseColor("#0b0b0c"));
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0b0b0c"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setUserAgentString(s.getUserAgentString() + " FLA-App/" + VERSION);
        web.addJavascriptInterface(new Bridge(), "FLA");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!"app.fla".equals(u.getHost())) return null;
                String path = u.getPath() == null || u.getPath().equals("/") ? "home.html" : u.getPath().substring(1);
                try {
                    String mime = path.endsWith(".js") ? "application/javascript" : path.endsWith(".png") ? "image/png" : "text/html";
                    return new WebResourceResponse(mime, "UTF-8", getAssets().open(path));
                } catch (Exception e) {
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", null, null);
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String sc = u.getScheme();
                if ("fla".equals(sc)) { handleUri(u); return true; }
                if ("http".equals(sc) || "https".equals(sc)) {
                    String p = u.getPath() == null ? "" : u.getPath();
                    if (p.startsWith("/api/app/")) {           // 下载链接交给系统浏览器
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                        return true;
                    }
                    return false;
                }
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) { curUrl = url; }

            @Override
            public void onPageFinished(WebView v, String url) {
                curUrl = url;
                pushStatus();
                if (autoStart && url.contains("/cast.html") && sid != null) {
                    autoStart = false;
                    startCapture();
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, android.webkit.WebResourceError e) {
                if (r.isForMainFrame() && !r.getUrl().toString().startsWith(HOME)) {
                    toastJs("网络连接失败，请检查网络或切换线路");
                    v.loadUrl(HOME);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest r) {
                ui.post(new Runnable() { @Override public void run() {
                    if (checkSelfPermission("android.permission.CAMERA") == PackageManager.PERMISSION_GRANTED) {
                        r.grant(r.getResources());
                    } else {
                        pendingPerm = r;
                        requestPermissions(new String[]{"android.permission.CAMERA"}, REQ_CAM);
                    }
                } });
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("image/*");
                    startActivityForResult(Intent.createChooser(i, "选择图片"), REQ_FILE);
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
                return true;
            }
        });
        setContentView(web);

        CastService.listener = new CastService.Listener() {
            @Override public void on(final String st) { ui.post(new Runnable() { @Override public void run() { pushStatus(st); } }); }
        };
        Intent i = getIntent();
        if (i != null && i.getData() != null && "fla".equals(i.getData().getScheme())) handleUri(i.getData());
        else web.loadUrl(HOME);
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (i != null && i.getData() != null && "fla".equals(i.getData().getScheme())) handleUri(i.getData());
    }

    /** fla://cast?sid=..&code=..&srv=..  浏览器网页一键唤起 → 打开会话页并开始整屏投屏 */
    void handleUri(Uri u) {
        String s = u.getQueryParameter("sid"), c = u.getQueryParameter("code"), srv = u.getQueryParameter("srv");
        if (s == null || c == null || srv == null || !srv.startsWith("http")) { web.loadUrl(HOME); return; }
        sid = s; code = c; server = srv;
        autoStart = true;
        web.loadUrl(srv + "/cast.html?sid=" + Uri.encode(s) + "&code=" + Uri.encode(c) + "&tab=cast");
    }

    @Override
    public void onBackPressed() {
        String u = curUrl == null ? "" : curUrl;
        if (u.startsWith(HOME)) { moveTaskToBack(true); return; }
        new AlertDialog.Builder(this).setMessage("断开与电脑的连接并返回首页？")
            .setPositiveButton("返回首页", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) { goHome(); }
            })
            .setNegativeButton("取消", null).show();
    }

    void goHome() {
        if (CastService.running) stopService(new Intent(this, CastService.class));
        web.loadUrl(HOME);
    }

    void toastJs(String s) {
        final String js = "setTimeout(function(){var m=document.getElementById('msg');if(m){m.textContent=" + JSONObject.quote(s)
            + ";m.style.display='block';setTimeout(function(){m.style.display='none'},3000)}},600)";
        ui.post(new Runnable() { @Override public void run() { web.evaluateJavascript(js, null); } });
    }

    String lastStatus = "";
    void pushStatus(String s) { lastStatus = s; pushStatus(); }
    void pushStatus() {
        String js = "window.flaStatus&&window.flaStatus(" + JSONObject.quote(lastStatus.isEmpty()
            ? "PPT、相册、任何 App 都能实时显示在大屏上" : lastStatus) + "," + CastService.running + ")";
        web.evaluateJavascript(js, null);
    }

    /** 只信任我们的线路和局域网电脑 (桥接方法会触发录屏) */
    boolean trusted() {
        try {
            String h = Uri.parse(curUrl).getHost();
            if (h == null) return false;
            return h.equals("app.fla") || h.endsWith("clrv.top") || h.endsWith("fyx.best")
                || h.startsWith("192.168.") || h.startsWith("10.") || h.matches("^172\\.(1[6-9]|2\\d|3[01])\\..*");
        } catch (Exception e) { return false; }
    }

    class Bridge {
        @JavascriptInterface public String version() { return VERSION; }

        @JavascriptInterface public void vibrate() {
            try { ((Vibrator) getSystemService(VIBRATOR_SERVICE)).vibrate(40); } catch (Exception ignored) { }
        }

        @JavascriptInterface public void home() { ui.post(new Runnable() { @Override public void run() { goHome(); } }); }

        @JavascriptInterface public void pair(final String srv, final String c) {
            new Thread(new Runnable() { @Override public void run() {
                String js;
                try {
                    JSONObject p = get(srv + "/api/remote/pair/" + Uri.encode(c));
                    js = "onPair(true," + JSONObject.quote(srv) + "," + JSONObject.quote(p.getString("session_id")) + "," + JSONObject.quote(c) + ")";
                } catch (Exception e) {
                    String m = String.valueOf(e.getMessage());
                    js = "onPair(false,'','','', " + JSONObject.quote(m.contains("HTTP 4") ? "配对码无效，请确认电脑已打开「手机」面板" : "网络不通，请检查网络或切换线路") + ")";
                }
                final String f = js;
                ui.post(new Runnable() { @Override public void run() { web.evaluateJavascript(f, null); } });
            } }).start();
        }

        @JavascriptInterface public void startScreen(final String s, final String c, final String srv) {
            if (!trusted()) return;
            ui.post(new Runnable() { @Override public void run() {
                sid = s; code = c; server = srv;
                startCapture();
            } });
        }

        @JavascriptInterface public void stopScreen() {
            ui.post(new Runnable() { @Override public void run() {
                stopService(new Intent(MainActivity.this, CastService.class));
                CastService.running = false;
                pushStatus("已停止整屏投屏");
            } });
        }
    }

    void startCapture() {
        pushStatus("正在查找电脑…");
        new Thread(new Runnable() { @Override public void run() {
            lanUrls.clear();
            try {
                JSONObject info = get(server + "/api/remote/" + sid + "/info?code=" + code);
                JSONArray lan = info.optJSONArray("lan");
                if (lan != null) for (int k = 0; k < lan.length(); k++) lanUrls.add(lan.getString(k));
            } catch (Exception ignored) { }
            ui.post(new Runnable() { @Override public void run() {
                pushStatus("请在系统弹窗中选择「整个屏幕」并点「立即开始」");
                MediaProjectionManager m = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
                startActivityForResult(m.createScreenCaptureIntent(), REQ_CAPTURE);
            } });
        } }).start();
    }

    JSONObject get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(10000);
        c.setRequestProperty("User-Agent", "FLA-Android/" + VERSION);
        try {
            int rc = c.getResponseCode();
            if (rc != 200) throw new Exception("HTTP " + rc);
            InputStream in = c.getInputStream();
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return new JSONObject(new String(b.toByteArray(), "UTF-8"));
        } finally {
            c.disconnect();
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] p, int[] g) {
        if (req == REQ_CAM && pendingPerm != null) {
            if (g.length > 0 && g[0] == PackageManager.PERMISSION_GRANTED) pendingPerm.grant(pendingPerm.getResources());
            else pendingPerm.deny();
            pendingPerm = null;
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE) {
            if (fileCb != null) fileCb.onReceiveValue(res == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
            fileCb = null;
            return;
        }
        if (req != REQ_CAPTURE) return;
        if (res != RESULT_OK || data == null) { pushStatus("已取消屏幕录制授权"); return; }
        Intent s = new Intent(this, CastService.class);
        s.putExtra("result", res);
        s.putExtra("data", data);
        s.putExtra("sid", sid);
        s.putExtra("code", code);
        s.putExtra("server", server);
        s.putStringArrayListExtra("lan", lanUrls);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(s); else startService(s);
        pushStatus("正在连接电脑…");
        moveTaskToBack(true);     // 回到桌面, 打开 PPT / 相册即可投到大屏
    }

    @Override
    protected void onDestroy() {
        CastService.listener = null;
        web.destroy();
        super.onDestroy();
    }
}
