package com.yg.subscriptionmanager;

import android.app.Activity;
import android.content.*;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;

/** No JavaScript bridge, root execution, account login, or embedded app secret. */
public final class MainActivity extends Activity {
    private static final String HOME = "http://127.0.0.1:8318/";
    private static final int SAVE = 11;
    private static final Set<String> OAUTH_HOSTS = Collections.unmodifiableSet(new HashSet<>(Arrays.asList(
        "auth.openai.com", "accounts.google.com", "claude.ai", "console.anthropic.com", "platform.openai.com")));
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Set<WebView> popups = new HashSet<>();
    private WebView web;
    private LinearLayout waiting;
    private TextView status;
    private boolean failed = true, destroyed, clearBootstrapHistory;
    private File exportFile;
    private boolean downloading;
    private final Runnable timeout = () -> { web.stopLoading(); showWaiting("连接超时，请确认本机管理服务已启动。"); };

    private static boolean internal(Uri uri) {
        return "http".equalsIgnoreCase(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
            && uri.getPort() == 8318 && uri.getUserInfo() == null;
    }
    private static boolean oauth(Uri uri) {
        return "https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null
            && OAUTH_HOSTS.contains(uri.getHost().toLowerCase(Locale.ROOT))
            && (uri.getPort() == -1 || uri.getPort() == 443) && uri.getUserInfo() == null;
    }
    private static boolean action(Uri uri, String host) {
        return ("stmanager://" + host).equals(uri.toString());
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(false);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(Color.rgb(16,29,39));
        getWindow().setNavigationBarColor(Color.rgb(16,29,39));
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(16,29,39));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        waiting = new LinearLayout(this);
        waiting.setOrientation(LinearLayout.VERTICAL);
        waiting.setGravity(Gravity.CENTER);
        int pad = (int)(24 * getResources().getDisplayMetrics().density);
        waiting.setPadding(pad,pad,pad,pad);
        waiting.setBackgroundColor(Color.rgb(16,29,39));
        status = new TextView(this);
        status.setTextColor(Color.WHITE); status.setTextSize(17); status.setGravity(Gravity.CENTER);
        waiting.addView(status, new LinearLayout.LayoutParams(-1,-2));
        Button retry = new Button(this); retry.setText("重新读取配置并重试");
        retry.setOnClickListener(v -> bootstrap()); waiting.addView(retry);
        root.addView(waiting, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root); root.requestApplyInsets();
        configure(web);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (internal(req.getUrl())) return false;
                if (req.isForMainFrame()) route(req.getUrl());
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (internal(Uri.parse(url))) return false;
                route(Uri.parse(url)); return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return internal(req.getUrl()) ? null : blocked();
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!internal(Uri.parse(url))) { view.stopLoading(); route(Uri.parse(url)); }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame() && internal(req.getUrl())) showWaiting("本机服务连接中断，请启动服务后重试。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse response) {
                if (req.isForMainFrame() && internal(req.getUrl()) && response.getStatusCode() >= 400)
                    showWaiting("管理服务响应 HTTP " + response.getStatusCode() + "，请核对私有配置后重试。");
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!failed && internal(Uri.parse(url))) {
                    handler.removeCallbacks(timeout); waiting.setVisibility(View.GONE);
                    if (clearBootstrapHistory) { web.clearHistory(); clearBootstrapHistory = false; }
                    CookieManager.getInstance().flush();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!internal(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) {
                    toast("已阻止非管理页面打开窗口"); return false;
                }
                final WebView popup = new WebView(MainActivity.this);
                configure(popup); popups.add(popup);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean routed;
                    private void forward(String url) {
                        if (routed || "about:blank".equals(url)) return;
                        routed = true; popup.stopLoading();
                        Uri uri = Uri.parse(url);
                        if (internal(uri)) web.loadUrl(url); else route(uri);
                        handler.post(() -> { popups.remove(popup); popup.destroy(); });
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) { forward(req.getUrl().toString()); return true; }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { forward(url); return true; }
                    @Override public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) { forward(url); }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) { return blocked(); }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); return true;
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, length) -> download(url));
        bootstrap();
    }
    private void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setAllowFileAccessFromFileURLs(false); s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        // OAuth launch may follow an asynchronous POST, after WebView's gesture token expires.
        // Every popup is an inert forwarding window, still subject to the exact URI allowlist.
        s.setSupportMultipleWindows(true); s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setMediaPlaybackRequiresUserGesture(true); s.setSaveFormData(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
    }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }
    private void bootstrap() {
        handler.removeCallbacks(timeout); web.stopLoading();
        showWaiting("正在读取私有配置并连接本机管理服务……");
        try {
            File config = new File(getFilesDir(), "manager-config.json");
            if (!config.isFile()) { showWaiting("尚未置入私有配置 manager-config.json。\n请由部署端写入应用 files 目录后点击重试。"); return; }
            if (config.length() > 16384) throw new IOException("配置文件过大");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream in = new FileInputStream(config)) {
                byte[] buffer = new byte[1024]; int n;
                while ((n = in.read(buffer)) != -1) {
                    bytes.write(buffer,0,n); if (bytes.size() > 16384) throw new IOException("配置文件过大");
                }
            }
            JSONObject json = new JSONObject(new String(bytes.toByteArray(), StandardCharsets.UTF_8));
            String base = json.getString("baseUrl");
            if (!HOME.equals(base)) throw new IOException("baseUrl 须为 " + HOME);
            String key = json.getString("appKey");
            if (key.trim().isEmpty() || key.length() > 4096 || !key.matches("[\\x21-\\x7E]+")) throw new IOException("appKey 须为非空可打印 ASCII 秘密");
            failed = false; clearBootstrapHistory = true;
            web.loadUrl(HOME + "bootstrap", Collections.singletonMap("X-App-Key", key));
            handler.postDelayed(timeout, 15000);
        } catch (Exception e) {
            // Never display JSON/parser contents or header values: these may contain appKey.
            showWaiting("私有配置读取或校验失败。\n请核对 UTF-8 JSON、固定 baseUrl 和非空 appKey，再重试。");
        }
    }
    private void route(Uri uri) {
        if (action(uri,"open-tavern") || action(uri,"restart-tavern")) {
            Intent launch = getPackageManager().getLaunchIntentForPackage("com.yg.sillytavern");
            if (launch == null) { toast("尚未安装酒馆应用"); return; }
            if (action(uri,"restart-tavern")) launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            try { startActivity(launch); } catch (ActivityNotFoundException e) { toast("酒馆应用启动失败"); }
        } else if (oauth(uri)) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
            catch (ActivityNotFoundException e) { toast("未找到系统浏览器"); }
        } else toast("已阻止非受信链接或协议");
    }
    private void showWaiting(String reason) {
        failed = true; handler.removeCallbacks(timeout);
        waiting.setVisibility(View.VISIBLE); status.setText(reason + "\n\n订阅管理 · 本机端口 8318");
    }
    private void download(String url) {
        Uri uri = Uri.parse(url);
        if (!internal(uri) || !"/api/diagnostics/download".equals(uri.getPath()) || uri.getQuery() != null || uri.getFragment() != null) {
            toast("仅支持本机诊断 JSON 下载"); return;
        }
        if (downloading || exportFile != null) { toast("请先完成当前诊断保存"); return; }
        downloading = true;
        String cookie = CookieManager.getInstance().getCookie(HOME);
        io.execute(() -> {
            File temp = null;
            try {
                temp = File.createTempFile("diagnostics-", ".json", getCacheDir());
                HttpURLConnection c = (HttpURLConnection)new URL(url).openConnection();
                c.setConnectTimeout(5000); c.setReadTimeout(15000); c.setInstanceFollowRedirects(false);
                if (cookie != null) c.setRequestProperty("Cookie", cookie);
                try {
                    if (c.getResponseCode() != 200) throw new IOException("HTTP status");
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                        byte[] b = new byte[8192]; int n, total = 0;
                        while ((n = in.read(b)) != -1) { total += n; if (total > 8*1024*1024) throw new IOException("size limit"); out.write(b,0,n); }
                    }
                } finally { c.disconnect(); }
                final File ready = temp;
                handler.post(() -> {
                    downloading = false;
                    if (destroyed) { ready.delete(); return; }
                    exportFile = ready;
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json").putExtra(Intent.EXTRA_TITLE,"subscription-diagnostics.json");
                    try { startActivityForResult(save, SAVE); }
                    catch (ActivityNotFoundException e) { ready.delete(); exportFile = null; toast("未找到文件保存器"); }
                });
            } catch (Exception e) {
                if (temp != null) temp.delete();
                handler.post(() -> { downloading = false; toast("诊断下载失败，请稍后重试"); });
            }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        if (request != SAVE || exportFile == null) return;
        File source = exportFile; exportFile = null;
        Uri target = data == null ? null : data.getData();
        if (result != RESULT_OK || target == null) { source.delete(); return; }
        io.execute(() -> {
            try (InputStream in = new FileInputStream(source); OutputStream out = getContentResolver().openOutputStream(target,"wt")) {
                if (out == null) throw new IOException("No output stream");
                byte[] b = new byte[8192]; int n; while ((n=in.read(b)) != -1) out.write(b,0,n);
                handler.post(() -> toast("诊断 JSON 已保存"));
            } catch (Exception e) { handler.post(() -> toast("诊断保存失败")); }
            finally { source.delete(); }
        });
    }
    private void toast(String text) { if (!destroyed) Toast.makeText(this,text,Toast.LENGTH_LONG).show(); }
    @Override public void onBackPressed() { if (!failed && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onResume() {
        super.onResume(); web.onResume();
        if (!failed && internal(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) web.evaluateJavascript("window.appResume?.()", null);
    }
    @Override protected void onPause() { CookieManager.getInstance().flush(); web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        destroyed = true; handler.removeCallbacksAndMessages(null);
        for (WebView popup : popups) popup.destroy(); popups.clear();
        if (exportFile != null) exportFile.delete();
        web.stopLoading(); web.destroy(); io.shutdownNow(); super.onDestroy();
    }
}
