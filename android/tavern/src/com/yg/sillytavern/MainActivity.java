package com.yg.sillytavern;

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
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final String HOME = "http://127.0.0.1:8000/";
    private static final int OPEN = 10, SAVE = 11;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private WebView web;
    private LinearLayout waiting;
    private TextView status;
    private ValueCallback<Uri[]> fileCallback;
    private File exportFile;
    private boolean checking, resumed, waitingForServer = true, destroyed;
    private final Runnable poll = () -> checkServer();

    private static boolean local(Uri u) {
        String h = u.getHost();
        return h != null && (h.equalsIgnoreCase("localhost") || h.equals("127.0.0.1") || h.equals("::1") || h.equals("[::1]"));
    }
    private static boolean internal(Uri u) {
        return local(u) && ("http".equalsIgnoreCase(u.getScheme()) || "https".equalsIgnoreCase(u.getScheme())) && (u.getPort() == 8000);
    }
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(Color.rgb(24,24,28));
        getWindow().setNavigationBarColor(Color.rgb(24,24,28));
        if (Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        else getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(24,24,28));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = insets.getInsets(WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets.consumeSystemWindowInsets();
        });
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        waiting = new LinearLayout(this);
        waiting.setOrientation(LinearLayout.VERTICAL);
        waiting.setGravity(Gravity.CENTER);
        waiting.setPadding(32,32,32,32);
        waiting.setBackgroundColor(Color.rgb(24,24,28));
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(18);
        status.setGravity(Gravity.CENTER);
        waiting.addView(status, new LinearLayout.LayoutParams(-1,-2));
        Button retry = new Button(this); retry.setText("立即重试");
        retry.setOnClickListener(v -> { handler.removeCallbacks(poll); checkServer(); });
        waiting.addView(retry);
        root.addView(waiting, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root); root.requestApplyInsets();
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri uri = req.getUrl();
                if (internal(uri)) return false;
                if (req.isForMainFrame()) external(uri);
                return true;
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showWaiting("页面连接中断：" + err.getDescription());
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse response) {
                if (req.isForMainFrame() && response.getStatusCode() >= 400) showWaiting("服务响应：HTTP " + response.getStatusCode());
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!waitingForServer && internal(Uri.parse(url))) {
                    waiting.setVisibility(View.GONE);
                    CookieManager.getInstance().flush();
                    injectDownloads();
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                // Character PNG/JSON and preset files often have inconsistent provider MIME labels.
                pick.setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivityForResult(pick, OPEN); }
                catch (ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; toast("未找到文件选择器"); }
                return true;
            }
            @Override public boolean onJsPrompt(WebView view, String url, String message, String def, JsPromptResult result) {
                if (!message.startsWith("YG_EXPORT:")) return false;
                if (!internal(Uri.parse(url))) { result.cancel(); return true; }
                try {
                    JSONObject data = new JSONObject(message.substring(10));
                    String raw = data.getString("data");
                    if (raw.length() > 96 * 1024 * 1024) throw new IOException("文件超过导出上限");
                    byte[] bytes = android.util.Base64.decode(raw, android.util.Base64.DEFAULT);
                    if (exportFile != null) throw new IOException("请先完成当前保存");
                    File f = File.createTempFile("export-", ".bin", getCacheDir());
                    try (OutputStream out = new FileOutputStream(f)) { out.write(bytes); }
                    requestSave(f, data.optString("name", "SillyTavern-export"), data.optString("mime", "application/octet-stream"));
                    result.confirm("ok");
                } catch (Exception e) { result.cancel(); toast("导出失败：" + e.getMessage()); }
                return true;
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, size) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) {
                web.evaluateJavascript("window.ygExport(" + JSONObject.quote(url) + "," + JSONObject.quote(URLUtil.guessFileName(url,disposition,mime)) + ")", null);
            } else download(url, URLUtil.guessFileName(url,disposition,mime), mime, ua);
        });
        showWaiting("正在检查本机服务……");
    }
    private void injectDownloads() {
        web.evaluateJavascript("(function(){if(window.ygExport)return;window.ygExport=async function(u,n){try{const r=await fetch(u);const b=await r.blob();if(b.size>64*1024*1024)throw Error('文件超过64MB');const f=new FileReader();f.onload=function(){prompt('YG_EXPORT:'+JSON.stringify({name:n||'SillyTavern-export',mime:b.type||'application/octet-stream',data:f.result.split(',')[1]}));};f.readAsDataURL(b);}catch(e){alert('导出失败：'+e.message)}};document.addEventListener('click',function(e){const a=e.target.closest&&e.target.closest('a');if(a&&(/^(blob:|data:)/).test(a.href)){e.preventDefault();e.stopImmediatePropagation();window.ygExport(a.href,a.download||'SillyTavern-export');}},true);})();", null);
    }
    private void external(Uri uri) {
        String scheme = uri.getScheme();
        if (!("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme))) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException e) { toast("未找到打开链接的应用"); }
    }
    private void showWaiting(String reason) {
        waitingForServer = true;
        waiting.setVisibility(View.VISIBLE);
        status.setText(reason + "\n\n等待 SillyTavern：http://127.0.0.1:8000/\n\n服务由现有 Droidspaces systemd 启动。请保持 Droidspaces 正常运行；本应用只连接服务，不启动终端、不请求 root。\n\n每 2 秒自动检查，也可点击重试。");
        handler.removeCallbacks(poll);
        if (resumed) handler.postDelayed(poll, 2000);
    }
    private void checkServer() {
        if (checking || destroyed || !resumed) return;
        checking = true;
        io.execute(() -> {
            boolean ready = false;
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection)new URL(HOME).openConnection();
                c.setConnectTimeout(1500); c.setReadTimeout(1500); c.setInstanceFollowRedirects(false);
                int code = c.getResponseCode(); ready = code >= 200 && code < 400;
            } catch (IOException ignored) {} finally { if (c != null) c.disconnect(); }
            final boolean ok = ready;
            handler.post(() -> {
                checking = false;
                if (destroyed || !resumed) return;
                if (ok) {
                    waitingForServer = false;
                    status.setText("服务已就绪，正在打开 SillyTavern……");
                    web.loadUrl(HOME);
                } else showWaiting("尚未连接到本机 SillyTavern 服务");
            });
        });
    }
    private void requestSave(File file, String name, String mime) {
        if (destroyed) { file.delete(); return; }
        if (exportFile != null) { file.delete(); toast("请先完成当前保存"); return; }
        exportFile = file;
        Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE);
        save.setType(mime == null || !mime.contains("/") ? "application/octet-stream" : mime);
        save.putExtra(Intent.EXTRA_TITLE, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
        try { startActivityForResult(save, SAVE); }
        catch (ActivityNotFoundException e) { exportFile.delete(); exportFile = null; toast("未找到文件保存器"); }
    }
    private void download(String url, String name, String mime, String ua) {
        if (!internal(Uri.parse(url))) { external(Uri.parse(url)); return; }
        String cookies = CookieManager.getInstance().getCookie(url);
        io.execute(() -> {
            File temp = null;
            try {
                temp = File.createTempFile("download-", ".bin", getCacheDir());
                String next = url;
                for (int redirects=0; redirects<6; redirects++) {
                    if (!internal(Uri.parse(next))) throw new IOException("下载跳转离开本机服务");
                    HttpURLConnection c = (HttpURLConnection)new URL(next).openConnection();
                    c.setConnectTimeout(10000); c.setReadTimeout(30000); c.setInstanceFollowRedirects(false);
                    if(cookies != null) c.setRequestProperty("Cookie", cookies);
                    c.setRequestProperty("User-Agent", ua);
                    try {
                        int code = c.getResponseCode();
                        if (code >= 300 && code < 400) { next = new URL(new URL(next), c.getHeaderField("Location")).toString(); continue; }
                        if(code < 200 || code >= 300) throw new IOException("HTTP " + code);
                        try(InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                            byte[] buf = new byte[65536]; int n; while((n=in.read(buf))!=-1) out.write(buf,0,n);
                        }
                        final File done = temp;
                        handler.post(() -> requestSave(done,name,mime)); return;
                    } finally { c.disconnect(); }
                }
                throw new IOException("下载跳转过多");
            } catch (Exception e) {
                if(temp != null) temp.delete(); handler.post(() -> toast("下载失败：" + e.getMessage()));
            }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        if(request == OPEN && fileCallback != null) {
            Uri[] uris = null;
            if(result == RESULT_OK && data != null) {
                ClipData clip = data.getClipData();
                if(clip != null) { uris = new Uri[clip.getItemCount()]; for(int i=0;i<uris.length;i++) uris[i]=clip.getItemAt(i).getUri(); }
                else if(data.getData()!=null) uris = new Uri[]{data.getData()};
            }
            fileCallback.onReceiveValue(uris); fileCallback=null;
        }
        if(request == SAVE && exportFile != null) {
            File source=exportFile; exportFile=null;
            Uri dest=data == null ? null : data.getData();
            if(result != RESULT_OK || dest == null) { source.delete(); return; }
            io.execute(() -> {
                try(InputStream in=new FileInputStream(source); OutputStream out=getContentResolver().openOutputStream(dest,"wt")) {
                    if(out == null) throw new IOException("存储提供程序未返回输出流");
                    byte[] b=new byte[65536]; int n; while((n=in.read(b))!=-1) out.write(b,0,n);
                    handler.post(() -> toast("文件已保存"));
                } catch(Exception e) { handler.post(() -> toast("保存失败："+e.getMessage())); }
                finally { source.delete(); }
            });
        }
    }
    private void toast(String s) { if(!destroyed) Toast.makeText(this,s,Toast.LENGTH_LONG).show(); }
    @Override public void onBackPressed() { if(web.canGoBack() && !waitingForServer) web.goBack(); else super.onBackPressed(); }
    @Override protected void onResume() { super.onResume(); resumed=true; web.onResume(); if(waitingForServer) checkServer(); }
    @Override protected void onPause() { resumed=false; handler.removeCallbacks(poll); CookieManager.getInstance().flush(); web.onPause(); super.onPause(); }
    @Override protected void onDestroy() {
        destroyed=true; handler.removeCallbacksAndMessages(null);
        if(fileCallback!=null) fileCallback.onReceiveValue(null);
        if(exportFile!=null) exportFile.delete();
        web.destroy(); io.shutdownNow(); super.onDestroy();
    }
}
