/*
 * bb-box-display: gives the desktop the HiDPI mode of its size, for the
 * session only.
 *
 *   bb-box-display hidpi
 *
 * A Mac with a display, or an HDMI dummy plug, offers each size at 1x and,
 * for some, at 2x: the same points with twice the pixels each way. Screen
 * Sharing sends pixels, and bb-box's viewer draws them on a screen that is
 * usually 2x, so a 2x mode is as sharp there as on the Mac, where a 1x one
 * is magnified. The points stay, so computer use's coordinates do too. The
 * change lasts until the user logs out, which the reset does. The helper
 * runs it as the box user, in its session, after the sign-in. It prints
 * hidpi= and the mode's pixels, or "hidpi=none" where the size has no 2x
 * mode, as with no display attached, and changes nothing then.
 */
#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 2 || strcmp(argv[1], "hidpi") != 0) {
    fprintf(stderr, "usage: bb-box-display hidpi\n");
    return 2;
  }
  CGDirectDisplayID display = CGMainDisplayID();
  CGDisplayModeRef current = CGDisplayCopyDisplayMode(display);
  if (!current) {
    fprintf(stderr, "bb-box-display: the display has no mode: is the user signed in?\n");
    return 1;
  }
  size_t width = CGDisplayModeGetWidth(current), height = CGDisplayModeGetHeight(current);
  if (CGDisplayModeGetPixelWidth(current) > width) {
    printf("hidpi=%zux%zu\n", CGDisplayModeGetPixelWidth(current), CGDisplayModeGetPixelHeight(current));
    return 0;
  }
  const void *keys[] = {kCGDisplayShowDuplicateLowResolutionModes};
  const void *values[] = {kCFBooleanTrue};
  CFDictionaryRef options = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFArrayRef modes = CGDisplayCopyAllDisplayModes(display, options);
  CFRelease(options);
  CGDisplayModeRef best = NULL;
  for (CFIndex i = 0; modes && i < CFArrayGetCount(modes); i++) {
    CGDisplayModeRef mode = (CGDisplayModeRef)CFArrayGetValueAtIndex(modes, i);
    if (CGDisplayModeGetWidth(mode) != width || CGDisplayModeGetHeight(mode) != height) continue;
    if (CGDisplayModeGetPixelWidth(mode) <= width || !CGDisplayModeIsUsableForDesktopGUI(mode)) continue;
    if (!best || CGDisplayModeGetRefreshRate(mode) > CGDisplayModeGetRefreshRate(best)) best = mode;
  }
  if (!best) {
    printf("hidpi=none\n");
    return 0;
  }
  CGDisplayConfigRef config;
  CGError error = CGBeginDisplayConfiguration(&config);
  if (error == kCGErrorSuccess) error = CGConfigureDisplayWithDisplayMode(config, display, best, NULL);
  if (error == kCGErrorSuccess) error = CGCompleteDisplayConfiguration(config, kCGConfigureForSession);
  if (error != kCGErrorSuccess) {
    fprintf(stderr, "bb-box-display: macOS refused the mode: CGError %d\n", error);
    return 1;
  }
  printf("hidpi=%zux%zu\n", CGDisplayModeGetPixelWidth(best), CGDisplayModeGetPixelHeight(best));
  return 0;
}
