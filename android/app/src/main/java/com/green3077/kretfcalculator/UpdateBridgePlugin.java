package com.green3077.kretfcalculator;

import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 사이드로드 앱은 스스로를 조용히 덮어쓸 수 없으므로(설치는 항상 사용자 확인 필요),
 * 새 APK URL을 외부 브라우저로 열어 다운로드->설치 흐름을 대신 시작해준다.
 */
@CapacitorPlugin(name = "UpdateBridge")
public class UpdateBridgePlugin extends Plugin {

    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url is required");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("openExternal failed", e);
        }
    }
}
