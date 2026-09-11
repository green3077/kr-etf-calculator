package com.green3077.kretfcalculator;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdateBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
