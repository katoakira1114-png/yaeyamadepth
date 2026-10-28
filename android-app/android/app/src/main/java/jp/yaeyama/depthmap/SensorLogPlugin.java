package jp.yaeyama.depthmap;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

// 撮影中の向き・ジャイロ・加速度・磁気を Android の SensorManager から直接ファイルへ書く。
// WebView の deviceorientation / devicemotion は端末によって届かないため（2026-10-28 の試し撮りで0件だった）。
// 時刻 t_ns は SystemClock.elapsedRealtimeNanos 基準（センサーの event.timestamp と同じ時計）。
// start() が返す elapsed_ns / epoch_ms と、JS 側で呼び出し前後に取った performance.now() で、動画やGPSの時刻と結びつける。
@CapacitorPlugin(name = "SensorLog")
public class SensorLogPlugin extends Plugin implements SensorEventListener {
    private SensorManager sm;
    private HandlerThread thread;
    private BufferedWriter out;
    private long count;

    // start({path: 'yaeyama_capture/<日時>/<日時>_sensors_native.csv', directory: 'DOCUMENTS'|'EXTERNAL'})
    @PluginMethod
    public void start(PluginCall call) {
        String rel = call.getString("path"), kind = call.getString("directory", "DOCUMENTS");
        if (rel == null) { call.reject("path が要ります"); return; }
        stopInternal();
        try {
            File base = "EXTERNAL".equals(kind) ? getContext().getExternalFilesDir(null) : Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS);
            File f = new File(base, rel);
            File dir = f.getParentFile();
            if (dir != null && !dir.exists() && !dir.mkdirs()) throw new Exception("フォルダを作れません: " + dir);
            out = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(f, true), StandardCharsets.UTF_8), 1 << 16);
            out.write("t_ns,kind,a,b,c,d,accuracy\n");
            count = 0;
            sm = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            thread = new HandlerThread("sensorlog");
            thread.start();
            Handler h = new Handler(thread.getLooper());
            JSObject avail = new JSObject();
            int[] types = {Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_GAME_ROTATION_VECTOR, Sensor.TYPE_GYROSCOPE,
                Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_MAGNETIC_FIELD, Sensor.TYPE_GYROSCOPE_UNCALIBRATED};
            for (int t : types) {
                Sensor s = sm.getDefaultSensor(t);
                avail.put(name(t), s != null);
                if (s != null) sm.registerListener(this, s, 10000, h); // 10ms（約100Hz）
            }
            JSObject o = new JSObject();
            o.put("elapsed_ns", SystemClock.elapsedRealtimeNanos());
            o.put("epoch_ms", System.currentTimeMillis());
            o.put("sensors", avail);
            call.resolve(o);
        } catch (Exception e) {
            stopInternal();
            call.reject("センサー記録を始められません: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        long n = count;
        stopInternal();
        JSObject o = new JSObject();
        o.put("rows", n);
        o.put("elapsed_ns", SystemClock.elapsedRealtimeNanos());
        o.put("epoch_ms", System.currentTimeMillis());
        call.resolve(o);
    }

    // 撮影画面の表示用（記録中の行数）
    @PluginMethod
    public void status(PluginCall call) {
        JSObject o = new JSObject();
        o.put("rows", count);
        call.resolve(o);
    }

    private synchronized void stopInternal() {
        if (sm != null) sm.unregisterListener(this);
        sm = null;
        if (thread != null) thread.quitSafely();
        thread = null;
        if (out != null) { try { out.flush(); out.close(); } catch (Exception ignored) { } }
        out = null;
    }

    private static String name(int t) {
        switch (t) {
            case Sensor.TYPE_ROTATION_VECTOR: return "rotvec";       // 北基準の向き（四元数 x,y,z,w）
            case Sensor.TYPE_GAME_ROTATION_VECTOR: return "gamerot"; // 磁気を使わない向き（北はずれていく）
            case Sensor.TYPE_GYROSCOPE: return "gyro_rads";
            case Sensor.TYPE_GYROSCOPE_UNCALIBRATED: return "gyro_uncal_rads";
            case Sensor.TYPE_ACCELEROMETER: return "acc_mps2";
            case Sensor.TYPE_MAGNETIC_FIELD: return "mag_uT";
            default: return "t" + t;
        }
    }

    @Override
    public synchronized void onSensorChanged(SensorEvent e) {
        if (out == null) return;
        int t = e.sensor.getType();
        float[] v = e.values;
        String d = "";
        if (t == Sensor.TYPE_ROTATION_VECTOR || t == Sensor.TYPE_GAME_ROTATION_VECTOR) {
            float[] q = new float[4];
            SensorManager.getQuaternionFromVector(q, v); // w,x,y,z
            v = new float[]{q[1], q[2], q[3], q[0]};       // x,y,z,w で書く
        }
        try {
            out.write(String.format(Locale.US, "%d,%s,%.6f,%.6f,%.6f,%s,%d\n", e.timestamp, name(t), v[0], v[1], v[2],
                v.length > 3 ? String.format(Locale.US, "%.6f", v[3]) : d, e.accuracy));
            count++;
        } catch (Exception ignored) { }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) { }

    @Override
    protected void handleOnDestroy() { stopInternal(); }
}
