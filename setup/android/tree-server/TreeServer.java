import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Rect;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class TreeServer {
    static final int VERSION = 2;
    static final int MOST_NODES = 6000;
    static final int MOST_DEPTH = 80;
    static final long INSTRUMENTATION_LOOK_MS = 100;
    static final long FIRST_WINDOWS_MS = 1_000;
    static final int WINDOWS_STILL_READS = 3;
    static final long FIRST_QUIET_MS = 300;
    static final long FIRST_QUIET_MOST_MS = 2_000;
    static final long KEYS_LANDED_QUIET_MS = 100;
    static final long KEYS_LANDED_MOST_MS = 1_500;
    static final int CLICKABLE = 1, LONG_CLICKABLE = 2, SCROLLABLE = 4, EDITABLE = 8, ENABLED = 16, FOCUSED = 32, CHECKABLE = 64, CHECKED = 128, SELECTED = 256, PASSWORD = 512, VISIBLE = 1024, SHOWING_HINT = 2048, FOCUSABLE = 4096;

    final Object lock = new Object();
    final long lingerMs;
    final HandlerThread thread = new HandlerThread("bb-box-tree");
    UiAutomation held;
    long lastReadAt;
    volatile boolean instrumentation;
    int nodes;
    Context context;

    TreeServer(long lingerMs) {
        this.lingerMs = lingerMs;
        thread.start();
    }

    public static void main(String[] args) throws Exception {
        Looper.prepareMainLooper();
        TreeServer server = new TreeServer(args.length > 0 ? Long.parseLong(args[0]) : 30_000);
        server.serve();
    }

    void serve() throws Exception {
        Thread watch = new Thread(this::watch, "bb-box-tree-watch");
        watch.setDaemon(true);
        watch.start();
        PrintStream out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), false, "UTF-8");
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        out.print("{\"ok\":true,\"hello\":" + VERSION + "}\n");
        out.flush();
        for (String line; (line = in.readLine()) != null; ) {
            String answer;
            try {
                answer = answer(line.trim());
            } catch (Throwable error) {
                answer = refusal("failed", String.valueOf(error));
            }
            out.print(answer);
            out.print('\n');
            out.flush();
        }
        letGo();
        System.exit(0);
    }

    String answer(String request) throws Exception {
        if (request.equals("tree")) return tree();
        if (request.equals("apps")) return apps();
        if (request.equals("paste")) return paste();
        if (request.equals("ping")) return "{\"ok\":true,\"version\":" + VERSION + ",\"held\":" + (held != null) + ",\"instrumentation\":" + instrumentation + "}";
        return refusal("bad-request", "No such request: " + request);
    }

    static String refusal(String code, String words) {
        return "{\"ok\":false,\"code\":" + quoted(code) + ",\"words\":" + quoted(words) + "}";
    }

    void watch() {
        for (;;) {
            if (held != null) {
                String other = anotherUser();
                instrumentation = other != null;
                synchronized (lock) {
                    boolean idle = held != null && System.currentTimeMillis() - lastReadAt >= lingerMs;
                    if (held != null && (other != null || idle)) {
                        letGo();
                        System.err.println(other != null ? "gave way to " + other : "let go after " + lingerMs + " ms idle");
                    }
                }
            }
            try {
                Thread.sleep(INSTRUMENTATION_LOOK_MS);
            } catch (InterruptedException ignored) {
                return;
            }
        }
    }

    static String anotherUser() {
        File[] entries = new File("/proc").listFiles();
        if (entries == null) return null;
        byte[] buffer = new byte[512];
        for (File entry : entries) {
            String name = entry.getName();
            if (name.isEmpty() || name.charAt(0) < '0' || name.charAt(0) > '9') continue;
            try (FileInputStream cmdline = new FileInputStream(new File(entry, "cmdline"))) {
                int read = cmdline.read(buffer);
                if (read <= 0) continue;
                String args = new String(buffer, 0, read, StandardCharsets.UTF_8).replace('\0', ' ');
                if (args.contains("com.android.commands.am.Am instrument")) return "an instrumentation";
                if (args.contains("com.android.commands.uiautomator.Launcher")) return "uiautomator";
            } catch (Exception ignored) {
            }
        }
        return null;
    }

    void letGo() {
        synchronized (lock) {
            if (held == null) return;
            try {
                Method disconnect = UiAutomation.class.getDeclaredMethod("disconnect");
                disconnect.setAccessible(true);
                disconnect.invoke(held);
            } catch (Throwable ignored) {
            }
            held = null;
        }
    }

    UiAutomation connected() throws Exception {
        if (held != null) return held;
        Class<?> connectionType = Class.forName("android.app.UiAutomationConnection");
        Constructor<?> connection = connectionType.getDeclaredConstructor();
        connection.setAccessible(true);
        Constructor<UiAutomation> make = UiAutomation.class.getDeclaredConstructor(Looper.class, Class.forName("android.app.IUiAutomationConnection"));
        make.setAccessible(true);
        UiAutomation automation = make.newInstance(thread.getLooper(), connection.newInstance());
        Method connect = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connect.setAccessible(true);
        try {
            connect.invoke(automation, 0);
        } catch (java.lang.reflect.InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof IllegalStateException) throw new HeldElsewhere(String.valueOf(cause.getMessage()));
            throw error;
        }
        AccessibilityServiceInfo info = automation.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS;
        automation.setServiceInfo(info);
        held = automation;
        return automation;
    }

    static final class HeldElsewhere extends Exception {
        HeldElsewhere(String words) {
            super(words);
        }
    }

    static final class Refused extends Exception {
        final String answer;

        Refused(String answer) {
            this.answer = answer;
        }
    }

    UiAutomation readyAutomation() throws Exception {
        boolean wasHeld = held != null;
        if (!wasHeld) {
            String other = anotherUser();
            instrumentation = other != null;
            if (other != null) throw new Refused(refusal("instrumentation", "bb-box's tree server gives way to " + other + " running on the device."));
        }
        UiAutomation automation;
        try {
            automation = connected();
        } catch (HeldElsewhere error) {
            throw new Refused(refusal("held-elsewhere", error.getMessage()));
        }
        if (!wasHeld) {
            awaitWindows(automation);
            awaitQuiet(automation);
        }
        return automation;
    }

    String paste() throws Exception {
        long began = System.nanoTime();
        synchronized (lock) {
            UiAutomation automation;
            try {
                automation = readyAutomation();
            } catch (Refused refused) {
                return refused.answer;
            }
            awaitKeysLanded(automation);
            AccessibilityNodeInfo field = focusedTextField(automation);
            boolean pasted = field != null && field.performAction(AccessibilityNodeInfo.ACTION_PASTE);
            automation.clearCache();
            lastReadAt = System.currentTimeMillis();
            if (lingerMs <= 0) letGo();
            String fieldClass = field == null ? null : String.valueOf(field.getClassName());
            return "{\"ok\":true,\"pasted\":" + pasted + ",\"field\":" + quoted(fieldClass) + ",\"ms\":" + (System.nanoTime() - began) / 1_000_000.0 + "}";
        }
    }

    static void awaitKeysLanded(UiAutomation automation) {
        long now = android.os.SystemClock.uptimeMillis();
        for (int action : new int[] {android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.ACTION_UP}) {
            android.view.KeyEvent marker = new android.view.KeyEvent(now, now, action, android.view.KeyEvent.KEYCODE_SHIFT_LEFT, 0);
            automation.injectInputEvent(marker, true);
        }
        try {
            automation.waitForIdle(KEYS_LANDED_QUIET_MS, KEYS_LANDED_MOST_MS);
        } catch (java.util.concurrent.TimeoutException stillBusy) {
        }
    }

    static AccessibilityNodeInfo focusedTextField(UiAutomation automation) {
        AccessibilityNodeInfo inputFocus = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        AccessibilityNodeInfo found = inputFocus == null ? null : focusedEditableWithin(inputFocus, 0);
        if (found != null) return found;
        AccessibilityNodeInfo root = automation.getRootInActiveWindow();
        return root == null ? null : focusedEditableWithin(root, 0);
    }

    static AccessibilityNodeInfo focusedEditableWithin(AccessibilityNodeInfo node, int depth) {
        if (node.isFocused() && node.isEditable()) return node;
        if (depth >= MOST_DEPTH) return null;
        for (int index = 0; index < node.getChildCount(); index++) {
            AccessibilityNodeInfo child = node.getChild(index);
            if (child == null) continue;
            AccessibilityNodeInfo found = focusedEditableWithin(child, depth + 1);
            if (found != null) return found;
        }
        return null;
    }

    String tree() throws Exception {
        long began = System.nanoTime();
        synchronized (lock) {
            boolean wasHeld = held != null;
            UiAutomation automation;
            try {
                automation = readyAutomation();
            } catch (Refused refused) {
                return refused.answer;
            }
            long connectedAt = System.nanoTime();
            StringBuilder out = new StringBuilder(64 * 1024);
            int[] display = display();
            out.append("{\"ok\":true,\"rotation\":").append(display[0]).append(",\"width\":").append(display[1]).append(",\"height\":").append(display[2]);
            out.append(",\"held\":").append(wasHeld).append(",\"windows\":[");
            nodes = 0;
            List<AccessibilityWindowInfo> windows = automation.getWindows();
            boolean first = true;
            for (AccessibilityWindowInfo window : windows) {
                AccessibilityNodeInfo root = window.getRoot();
                if (!first) out.append(',');
                first = false;
                Rect bounds = new Rect();
                window.getBoundsInScreen(bounds);
                out.append("{\"type\":").append(window.getType()).append(",\"layer\":").append(window.getLayer());
                out.append(",\"title\":").append(quoted(window.getTitle())).append(",\"active\":").append(window.isActive()).append(",\"focused\":").append(window.isFocused());
                out.append(",\"b\":").append(box(bounds));
                if (root != null) {
                    out.append(",\"pkg\":").append(quoted(root.getPackageName()));
                    out.append(",\"root\":");
                    node(root, out, 0);
                }
                out.append('}');
            }
            if (windows.isEmpty()) {
                AccessibilityNodeInfo root = automation.getRootInActiveWindow();
                if (root != null) {
                    out.append("{\"type\":1,\"layer\":0,\"title\":null,\"active\":true,\"focused\":true,\"b\":[0,0,").append(display[1]).append(',').append(display[2]).append("],\"pkg\":").append(quoted(root.getPackageName())).append(",\"root\":");
                    node(root, out, 0);
                    out.append('}');
                }
            }
            lastReadAt = System.currentTimeMillis();
            if (lingerMs <= 0) letGo();
            long done = System.nanoTime();
            out.append("],\"nodes\":").append(nodes).append(",\"connectMs\":").append((connectedAt - began) / 1_000_000.0).append(",\"ms\":").append((done - began) / 1_000_000.0).append('}');
            return out.toString();
        }
    }

    static void awaitWindows(UiAutomation automation) {
        long until = System.currentTimeMillis() + FIRST_WINDOWS_MS;
        String last = "";
        int same = 0;
        while (System.currentTimeMillis() < until) {
            List<AccessibilityWindowInfo> windows = automation.getWindows();
            boolean ready = !windows.isEmpty();
            boolean active = false;
            StringBuilder seen = new StringBuilder();
            for (AccessibilityWindowInfo window : windows) {
                if (window.getRoot() == null) ready = false;
                if (window.isActive()) active = true;
                seen.append(window.getId()).append(':').append(window.getTitle()).append(';');
            }
            same = seen.toString().equals(last) ? same + 1 : 0;
            last = seen.toString();
            if (ready && active && same >= WINDOWS_STILL_READS) return;
            try {
                Thread.sleep(20);
            } catch (InterruptedException ignored) {
                return;
            }
        }
    }

    static void awaitQuiet(UiAutomation automation) {
        try {
            automation.waitForIdle(FIRST_QUIET_MS, FIRST_QUIET_MOST_MS);
        } catch (java.util.concurrent.TimeoutException stillBusy) {
        }
    }

    void node(AccessibilityNodeInfo node, StringBuilder out, int depth) {
        nodes++;
        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        int flags = (node.isClickable() ? CLICKABLE : 0) | (node.isLongClickable() ? LONG_CLICKABLE : 0) | (node.isScrollable() ? SCROLLABLE : 0) | (node.isEditable() ? EDITABLE : 0)
            | (node.isEnabled() ? ENABLED : 0) | (node.isFocused() ? FOCUSED : 0) | (node.isCheckable() ? CHECKABLE : 0) | (node.isChecked() ? CHECKED : 0) | (node.isSelected() ? SELECTED : 0)
            | (node.isPassword() ? PASSWORD : 0) | (node.isVisibleToUser() ? VISIBLE : 0) | (node.isShowingHintText() ? SHOWING_HINT : 0) | (node.isFocusable() ? FOCUSABLE : 0);
        out.append("{\"c\":").append(quoted(node.getClassName())).append(",\"b\":").append(box(bounds)).append(",\"f\":").append(flags);
        field(out, "t", node.getText());
        field(out, "d", node.getContentDescription());
        field(out, "h", node.getHintText());
        field(out, "i", node.getViewIdResourceName());
        field(out, "s", node.getStateDescription());
        AccessibilityNodeInfo.RangeInfo range = node.getRangeInfo();
        if (range != null) out.append(",\"r\":[").append(range.getMin()).append(',').append(range.getMax()).append(',').append(range.getCurrent()).append(']');
        int count = node.getChildCount();
        if (count > 0 && depth < MOST_DEPTH) {
            out.append(",\"k\":[");
            boolean first = true;
            for (int index = 0; index < count && nodes < MOST_NODES; index++) {
                AccessibilityNodeInfo child = node.getChild(index);
                if (child == null) continue;
                if (!first) out.append(',');
                first = false;
                node(child, out, depth + 1);
            }
            out.append(']');
        }
        out.append('}');
    }

    static void field(StringBuilder out, String key, CharSequence value) {
        if (value == null || value.length() == 0) return;
        out.append(",\"").append(key).append("\":").append(quoted(value));
    }

    static String box(Rect bounds) {
        return "[" + bounds.left + "," + bounds.top + "," + bounds.right + "," + bounds.bottom + "]";
    }

    static int[] display() {
        try {
            Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Object instance = global.getDeclaredMethod("getInstance").invoke(null);
            Object info = global.getDeclaredMethod("getDisplayInfo", int.class).invoke(instance, 0);
            Class<?> type = info.getClass();
            return new int[] {type.getField("rotation").getInt(info), type.getField("logicalWidth").getInt(info), type.getField("logicalHeight").getInt(info)};
        } catch (Throwable error) {
            return new int[] {-1, 0, 0};
        }
    }

    String apps() throws Exception {
        long began = System.nanoTime();
        PackageManager manager = context().getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> found = manager.queryIntentActivities(launcher, 0);
        StringBuilder out = new StringBuilder("{\"ok\":true,\"apps\":[");
        boolean first = true;
        for (ResolveInfo each : found) {
            if (!first) out.append(',');
            first = false;
            out.append("{\"pkg\":").append(quoted(each.activityInfo.packageName)).append(",\"activity\":").append(quoted(each.activityInfo.name)).append(",\"label\":").append(quoted(each.loadLabel(manager)));
            out.append(",\"system\":").append((each.activityInfo.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0).append('}');
        }
        out.append("],\"ms\":").append((System.nanoTime() - began) / 1_000_000.0).append('}');
        return out.toString();
    }

    Context context() throws Exception {
        if (context != null) return context;
        Class<?> activityThread = Class.forName("android.app.ActivityThread");
        Constructor<?> make = activityThread.getDeclaredConstructor();
        make.setAccessible(true);
        Object current = make.newInstance();
        Field currentField = activityThread.getDeclaredField("sCurrentActivityThread");
        currentField.setAccessible(true);
        currentField.set(null, current);
        Method systemContext = activityThread.getDeclaredMethod("getSystemContext");
        systemContext.setAccessible(true);
        context = (Context) systemContext.invoke(current);
        return context;
    }

    static String quoted(CharSequence value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder(value.length() + 2).append('"');
        for (int index = 0; index < value.length(); index++) {
            char at = value.charAt(index);
            switch (at) {
                case '"': out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n"); break;
                case '\r': out.append("\\r"); break;
                case '\t': out.append("\\t"); break;
                default:
                    if (at < 0x20 || at == 0x2028 || at == 0x2029) out.append(String.format("\\u%04x", (int) at));
                    else out.append(at);
            }
        }
        return out.append('"').toString();
    }
}
