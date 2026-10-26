package bbbox.probe;

import android.app.Activity;
import android.os.Bundle;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class Main extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        TextView title = new TextView(this);
        title.setText("Probe under test");
        Button button = new Button(this);
        button.setText("Tap me");
        button.setOnClickListener(view -> title.setText("Tapped"));
        column.addView(title);
        column.addView(button);
        setContentView(column);
    }
}
