package bbbox.probe;

import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;

public class Holds extends Instrumentation {
    private int seconds;

    @Override
    public void onCreate(Bundle arguments) {
        seconds = Integer.parseInt(arguments.getString("seconds", "10"));
        start();
    }

    @Override
    public void onStart() {
        Bundle result = new Bundle();
        long began = SystemClock.elapsedRealtime();
        try {
            UiAutomation automation = getUiAutomation();
            result.putString("connected_ms", String.valueOf(SystemClock.elapsedRealtime() - began));
            Intent intent = new Intent(getTargetContext(), Main.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivitySync(intent);
            int reads = 0;
            long until = SystemClock.elapsedRealtime() + seconds * 1000L;
            while (SystemClock.elapsedRealtime() < until) {
                if (automation.getRootInActiveWindow() != null) reads++;
                SystemClock.sleep(500);
            }
            result.putString("reads", String.valueOf(reads));
            result.putString("outcome", "passed");
            finish(0, result);
        } catch (Throwable error) {
            result.putString("outcome", "failed: " + error);
            finish(1, result);
        }
    }
}
