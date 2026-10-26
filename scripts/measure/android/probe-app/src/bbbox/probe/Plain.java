package bbbox.probe;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;

public class Plain extends Instrumentation {
    private int seconds;

    @Override
    public void onCreate(Bundle arguments) {
        seconds = Integer.parseInt(arguments.getString("seconds", "10"));
        start();
    }

    @Override
    public void onStart() {
        Bundle result = new Bundle();
        try {
            Intent intent = new Intent(getTargetContext(), Main.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivitySync(intent);
            SystemClock.sleep(seconds * 1000L);
            result.putString("outcome", "passed");
            finish(0, result);
        } catch (Throwable error) {
            result.putString("outcome", "failed: " + error);
            finish(1, result);
        }
    }
}
