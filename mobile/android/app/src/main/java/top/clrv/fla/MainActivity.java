package top.clrv.fla;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** FLA 投屏: 输入电脑上显示的 4 位配对码 → 把手机整个屏幕实时投到电脑 */
public class MainActivity extends Activity {
    static final String[] SERVERS = {"https://t.clrv.top", "https://t.fyx.best"};
    static final int REQ_CAPTURE = 7;

    EditText codeInput;
    RadioGroup serverGroup;
    TextView status;
    Button startBtn, stopBtn;
    String sid, code, server;
    ArrayList<String> lanUrls = new ArrayList<>();
    final Handler ui = new Handler(Looper.getMainLooper());
    final OkHttpClient http = new OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(10, TimeUnit.SECONDS).build();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        int pad = dp(24);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, dp(48), pad, pad);
        root.setBackgroundColor(Color.WHITE);

        TextView title = new TextView(this);
        title.setText("FLA 手机投屏");
        title.setTextSize(26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(Color.BLACK);
        root.addView(title);
        TextView sub = new TextView(this);
        sub.setText("把手机整个屏幕实时投到电脑大屏。\n电脑端：工具栏「手机」→ 面板上显示 4 位配对码。");
        sub.setTextColor(0xFF666666);
        sub.setPadding(0, dp(6), 0, dp(20));
        root.addView(sub);

        codeInput = new EditText(this);
        codeInput.setHint("4 位配对码");
        codeInput.setInputType(InputType.TYPE_CLASS_NUMBER);
        codeInput.setTextSize(30);
        codeInput.setGravity(Gravity.CENTER);
        codeInput.setLetterSpacing(0.4f);
        root.addView(codeInput);

        serverGroup = new RadioGroup(this);
        serverGroup.setOrientation(RadioGroup.HORIZONTAL);
        serverGroup.setPadding(0, dp(12), 0, dp(12));
        for (int i = 0; i < SERVERS.length; i++) {
            RadioButton r = new RadioButton(this);
            r.setId(100 + i);
            r.setText(i == 0 ? "线路一 t.clrv.top" : "线路二 t.fyx.best");
            serverGroup.addView(r);
        }
        SharedPreferences sp = getSharedPreferences("fla", MODE_PRIVATE);
        serverGroup.check(100 + sp.getInt("server", 0));
        root.addView(serverGroup);

        startBtn = new Button(this);
        startBtn.setText("开始投屏");
        startBtn.setTextSize(18);
        startBtn.setOnClickListener(v -> begin());
        root.addView(startBtn);
        stopBtn = new Button(this);
        stopBtn.setText("停止投屏");
        stopBtn.setOnClickListener(v -> {
            stopService(new Intent(this, CastService.class));
            setStatus("已停止");
        });
        root.addView(stopBtn);

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, 0);
        status.setTextColor(0xFF333333);
        root.addView(status);

        TextView tip = new TextView(this);
        tip.setText("提示：手机和电脑连同一个 Wi-Fi 时自动直连，延迟最低；否则经服务器中转。\n投屏期间可切到任何 App（PPT、相册、浏览器…），通知栏可停止。");
        tip.setTextColor(0xFF888888);
        tip.setTextSize(12);
        tip.setPadding(0, dp(24), 0, 0);
        root.addView(tip);
        setContentView(root);
        CastService.listener = s -> ui.post(() -> setStatus(s));
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        handleIntent(i);
    }

    /** fla://cast?sid=..&code=..&srv=..  (网页一键唤起) */
    void handleIntent(Intent i) {
        Uri u = i == null ? null : i.getData();
        if (u == null || !"fla".equals(u.getScheme())) return;
        String c = u.getQueryParameter("code"), srv = u.getQueryParameter("srv");
        if (c != null) codeInput.setText(c);
        if (srv != null) for (int k = 0; k < SERVERS.length; k++) if (SERVERS[k].equals(srv)) serverGroup.check(100 + k);
        if (c != null) begin();
    }

    void setStatus(String s) { status.setText(s); }

    int dp(int v) { return (int) (v * getResources().getDisplayMetrics().density + 0.5f); }

    void begin() {
        code = codeInput.getText().toString().trim();
        if (code.length() != 4) { setStatus("请输入电脑上显示的 4 位配对码"); return; }
        int idx = Math.max(0, serverGroup.getCheckedRadioButtonId() - 100);
        server = SERVERS[Math.min(idx, SERVERS.length - 1)];
        getSharedPreferences("fla", MODE_PRIVATE).edit().putInt("server", idx).apply();
        setStatus("正在查找电脑…");
        new Thread(() -> {
            try {
                JSONObject p = get(server + "/api/remote/pair/" + code);
                sid = p.getString("session_id");
                lanUrls.clear();
                try {
                    JSONObject info = get(server + "/api/remote/" + sid + "/info?code=" + code);
                    JSONArray lan = info.optJSONArray("lan");
                    if (lan != null) for (int k = 0; k < lan.length(); k++) lanUrls.add(lan.getString(k));
                } catch (Exception ignored) { }
                ui.post(this::askCapture);
            } catch (Exception e) {
                ui.post(() -> setStatus("配对码无效或网络不通：请确认电脑已打开「手机投屏」面板\n(" + e.getMessage() + ")"));
            }
        }).start();
    }

    JSONObject get(String url) throws Exception {
        try (Response r = http.newCall(new Request.Builder().url(url).header("User-Agent", "FLA-Android/1.0").build()).execute()) {
            if (!r.isSuccessful()) throw new Exception("HTTP " + r.code());
            return new JSONObject(r.body().string());
        }
    }

    void askCapture() {
        setStatus("请在系统弹窗中选择「整个屏幕」并点击「立即开始」");
        MediaProjectionManager m = (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        startActivityForResult(m.createScreenCaptureIntent(), REQ_CAPTURE);
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_CAPTURE) return;
        if (res != RESULT_OK || data == null) { setStatus("已取消屏幕录制授权"); return; }
        Intent s = new Intent(this, CastService.class);
        s.putExtra("result", res);
        s.putExtra("data", data);
        s.putExtra("sid", sid);
        s.putExtra("code", code);
        s.putExtra("server", server);
        s.putStringArrayListExtra("lan", lanUrls);
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(s); else startService(s);
        setStatus("正在连接电脑…");
        moveTaskToBack(true);
    }
}
