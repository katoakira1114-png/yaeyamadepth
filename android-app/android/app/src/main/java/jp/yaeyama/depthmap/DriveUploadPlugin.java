package jp.yaeyama.depthmap;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

// 撮影したフォルダを Google ドライブの「yaeyama_capture」へアップロードする。
// 権限は drive.file（このアプリが作ったファイルとフォルダだけ触れる）。ログインは Google の AuthorizationClient に任せ、
// 初回だけアカウント選択と許可の画面が出る。アップロードは再開可能アップロード（8MBずつ）で、通信が切れても続きから送り直す。
// 送り終えたファイルは「パス＋サイズ」で覚えておき、二重に送らない。
@CapacitorPlugin(name = "DriveUpload")
public class DriveUploadPlugin extends Plugin {
    private static final String SCOPE = "https://www.googleapis.com/auth/drive.file";
    private static final String FOLDER = "yaeyama_capture";
    private static final int CHUNK = 8 * 1024 * 1024; // 256KB の倍数であること
    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall pendingAuth;
    private volatile boolean busy = false;

    @Override
    public void load() {
        consent = getActivity().registerForActivityResult(new ActivityResultContracts.StartIntentSenderForResult(), res -> {
            PluginCall call = pendingAuth;
            pendingAuth = null;
            if (call == null) return;
            if (res.getResultCode() != Activity.RESULT_OK || res.getData() == null) { call.reject("許可されませんでした", "denied"); return; }
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(res.getData());
                resolveToken(call, r.getAccessToken());
            } catch (Exception e) { call.reject("許可の結果を読めませんでした: " + e.getMessage(), "denied"); }
        });
    }

    private void resolveToken(PluginCall call, String token) {
        if (token == null) { call.reject("トークンが取れませんでした", "denied"); return; }
        JSObject o = new JSObject();
        o.put("token", token);
        call.resolve(o);
    }

    // アクセストークンを得る（許可済みなら画面なしで返る）
    @PluginMethod
    public void authorize(PluginCall call) {
        AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(Collections.singletonList(new Scope(SCOPE))).build();
        Identity.getAuthorizationClient(getActivity()).authorize(req)
            .addOnSuccessListener(r -> {
                if (r.hasResolution() && r.getPendingIntent() != null) {
                    if (pendingAuth != null) pendingAuth.reject("やり直してください", "busy");
                    pendingAuth = call;
                    consent.launch(new IntentSenderRequest.Builder(r.getPendingIntent().getIntentSender()).build());
                } else resolveToken(call, r.getAccessToken());
            })
            .addOnFailureListener(e -> call.reject("Google の許可に失敗しました: " + e.getMessage() + "（Google Cloud の登録を確認）", "auth"));
    }

    // upload({token, directory: 'DOCUMENTS'|'EXTERNAL', path: 'yaeyama_capture/<日時>'})
    // 進み具合は 'progress' イベント {file, sent, total, done, of}。終わると {uploaded, skipped}。
    @PluginMethod
    public void upload(PluginCall call) {
        String token = call.getString("token"), rel = call.getString("path"), kind = call.getString("directory", "DOCUMENTS");
        if (token == null || rel == null) { call.reject("token と path が要ります"); return; }
        if (busy) { call.reject("アップロード中です", "busy"); return; }
        File base = "EXTERNAL".equals(kind) ? getContext().getExternalFilesDir(null) : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
        File dir = new File(base, rel);
        File[] list = dir.listFiles();
        if (list == null) { call.reject("フォルダが見つかりません: " + dir); return; }
        List<File> files = new ArrayList<>();
        for (File f : list) if (f.isFile() && f.length() > 0) files.add(f);
        Collections.sort(files, (a, b) -> Long.compare(a.length(), b.length())); // 小さい物から（CSV を先に届ける）
        busy = true;
        new Thread(() -> {
            try {
                String folderId = folderId(token);
                int up = 0, skip = 0, i = 0;
                SharedPreferences sp = getContext().getSharedPreferences("drive_upload", Context.MODE_PRIVATE);
                for (File f : files) {
                    i++;
                    String key = f.getAbsolutePath() + "|" + f.length();
                    if (sp.getBoolean(key, false)) { skip++; continue; }
                    sendFile(token, folderId, f, i, files.size());
                    sp.edit().putBoolean(key, true).apply();
                    up++;
                }
                JSObject o = new JSObject();
                o.put("uploaded", up);
                o.put("skipped", skip);
                call.resolve(o);
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            } finally { busy = false; }
        }).start();
    }

    private String folderId(String token) throws Exception {
        String q = "name='" + FOLDER + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
        JSONObject r = new JSONObject(http("GET", "https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + URLEncoder.encode(q, "UTF-8"), token, null, null));
        JSONArray a = r.getJSONArray("files");
        if (a.length() > 0) return a.getJSONObject(0).getString("id");
        JSONObject m = new JSONObject();
        m.put("name", FOLDER);
        m.put("mimeType", "application/vnd.google-apps.folder");
        return new JSONObject(http("POST", "https://www.googleapis.com/drive/v3/files?fields=id", token, m.toString(), null)).getString("id");
    }

    private void sendFile(String token, String folderId, File f, int idx, int of) throws Exception {
        long total = f.length();
        JSONObject meta = new JSONObject();
        meta.put("name", f.getName());
        meta.put("parents", new JSONArray(Arrays.asList(folderId)));
        String session = null;
        for (int t = 0; session == null; t++) {
            try { session = startSession(token, meta.toString(), total); }
            catch (IOException e) { if (t >= 5) throw e; pause(t); }
        }
        long sent = 0;
        int fails = 0;
        try (RandomAccessFile in = new RandomAccessFile(f, "r")) {
            byte[] buf = new byte[CHUNK];
            while (sent < total) {
                int n = (int) Math.min(CHUNK, total - sent);
                in.seek(sent);
                in.readFully(buf, 0, n);
                try {
                    HttpURLConnection c = (HttpURLConnection) new URL(session).openConnection();
                    c.setRequestMethod("PUT");
                    c.setConnectTimeout(30000);
                    c.setReadTimeout(120000);
                    c.setDoOutput(true);
                    c.setFixedLengthStreamingMode(n);
                    c.setRequestProperty("Content-Range", "bytes " + sent + "-" + (sent + n - 1) + "/" + total);
                    try (OutputStream os = c.getOutputStream()) { os.write(buf, 0, n); }
                    int code = c.getResponseCode();
                    if (code == 200 || code == 201) { sent = total; progress(f, sent, total, idx, of); return; }
                    if (code == 308) { sent = rangeEnd(c.getHeaderField("Range")); fails = 0; progress(f, sent, total, idx, of); continue; }
                    if (code == 404 || code == 410) throw new Exception("アップロードの受付が切れました（" + f.getName() + "）。もう一度送ってください");
                    if (code == 401) throw new Exception("Google の許可が切れました。もう一度送ってください");
                    throw new IOException("HTTP " + code);
                } catch (IOException e) {
                    if (++fails > 30) throw new Exception("通信が続けて失敗しました（" + f.getName() + "）: " + e.getMessage());
                    pause(Math.min(fails, 6));
                    sent = queryOffset(session, total); // どこまで届いたか聞き直して続きから
                    if (sent >= total) { progress(f, total, total, idx, of); return; }
                }
            }
        }
    }

    private String startSession(String token, String meta, long total) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id").openConnection();
        c.setRequestMethod("POST");
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        c.setDoOutput(true);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        c.setRequestProperty("X-Upload-Content-Length", String.valueOf(total));
        byte[] b = meta.getBytes(StandardCharsets.UTF_8);
        c.setFixedLengthStreamingMode(b.length);
        try (OutputStream os = c.getOutputStream()) { os.write(b); }
        int code = c.getResponseCode();
        String loc = c.getHeaderField("Location");
        if (code != 200 || loc == null) throw new IOException("アップロードを始められません HTTP " + code + " " + readErr(c));
        return loc;
    }

    private long queryOffset(String session, long total) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(session).openConnection();
            c.setRequestMethod("PUT");
            c.setConnectTimeout(30000);
            c.setReadTimeout(60000);
            c.setDoOutput(true);
            c.setFixedLengthStreamingMode(0);
            c.setRequestProperty("Content-Range", "bytes */" + total);
            c.getOutputStream().close();
            int code = c.getResponseCode();
            if (code == 200 || code == 201) return total;
            if (code == 308) return rangeEnd(c.getHeaderField("Range"));
        } catch (IOException ignored) { }
        return 0; // 分からなければ最初から（同じセッションなので重複はしない）
    }

    private static long rangeEnd(String range) { // "bytes=0-1234" → 1235
        if (range == null) return 0;
        int d = range.lastIndexOf('-');
        return d < 0 ? 0 : Long.parseLong(range.substring(d + 1).trim()) + 1;
    }

    private void progress(File f, long sent, long total, int idx, int of) {
        JSObject o = new JSObject();
        o.put("file", f.getName());
        o.put("sent", sent);
        o.put("total", total);
        o.put("done", idx);
        o.put("of", of);
        notifyListeners("progress", o);
    }

    private static void pause(int t) {
        try { Thread.sleep(Math.min(60000, 2000L << Math.min(t, 5))); } catch (InterruptedException ignored) { }
    }

    private static String http(String method, String url, String token, String body, String type) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            c.setDoOutput(true);
            c.setRequestProperty("Content-Type", type != null ? type : "application/json; charset=UTF-8");
            c.setFixedLengthStreamingMode(b.length);
            try (OutputStream os = c.getOutputStream()) { os.write(b); }
        }
        int code = c.getResponseCode();
        if (code == 401) throw new Exception("Google の許可が切れました。もう一度送ってください");
        if (code / 100 != 2) throw new Exception("ドライブ API エラー HTTP " + code + " " + readErr(c));
        return read(c.getInputStream());
    }

    private static String readErr(HttpURLConnection c) {
        try { InputStream e = c.getErrorStream(); if (e == null) return ""; String s = read(e); return s.length() > 300 ? s.substring(0, 300) : s; } catch (Exception x) { return ""; }
    }

    private static String read(InputStream in) throws IOException {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = in.read(b)) > 0) o.write(b, 0, n);
        in.close();
        return o.toString("UTF-8");
    }
}
