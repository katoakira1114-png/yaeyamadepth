package jp.yaeyama.depthmap;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DriveUploadPlugin.class); // アプリ内の自前プラグイン（撮影データをドライブへ）
        registerPlugin(SensorLogPlugin.class);   // 撮影中のセンサーを直接ファイルへ
        super.onCreate(savedInstanceState);
    }
}
