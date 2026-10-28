#import <Accelerate/Accelerate.h>
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurface.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include "encoder.h"

enum { SURFACE_RECHECK_US = 500000, SCREEN_WAIT_US = 30000000, SCREEN_POLL_US = 250000 };

static const char *const CORE_SIMULATOR = "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator";

static atomic_int key_wanted;
static atomic_int scale_wanted;

static id send_object(id target, const char *selector) {
  return ((id(*)(id, SEL))objc_msgSend)(target, sel_registerName(selector));
}

static NSString *developer_folder(const char *given) {
  if (given) return @(given);
  FILE *answer = popen("/usr/bin/xcode-select -p 2>/dev/null", "r");
  char line[1024] = {0};
  if (answer) {
    if (!fgets(line, sizeof line, answer)) line[0] = 0;
    pclose(answer);
  }
  line[strcspn(line, "\n")] = 0;
  if (!line[0]) refuse("xcode-select names no Xcode, and --developer was not given");
  return @(line);
}

static void load_simulator_kit(NSString *developer) {
  NSString *contents = [developer stringByDeletingLastPathComponent];
  NSArray<NSString *> *places = @[
    [contents stringByAppendingPathComponent:@"SharedFrameworks/SimulatorKit.framework/SimulatorKit"],
    [developer stringByAppendingPathComponent:@"Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit"],
  ];
  for (NSString *place in places)
    if (dlopen(place.UTF8String, RTLD_NOW)) return;
}

static id device_with_udid(NSString *udid, NSString *developer) {
  if (!dlopen(CORE_SIMULATOR, RTLD_NOW)) refuse("cannot load CoreSimulator: %s", dlerror());
  load_simulator_kit(developer);
  Class contexts = NSClassFromString(@"SimServiceContext");
  if (!contexts) refuse("CoreSimulator has no SimServiceContext");
  NSError *error = nil;
  id context = ((id(*)(id, SEL, id, NSError **))objc_msgSend)(contexts, sel_registerName("sharedServiceContextForDeveloperDir:error:"), developer, &error);
  if (!context) refuse("CoreSimulator gave no service context: %s", error.localizedDescription.UTF8String ?: "no reason");
  id set = ((id(*)(id, SEL, NSError **))objc_msgSend)(context, sel_registerName("defaultDeviceSetWithError:"), &error);
  if (!set) refuse("CoreSimulator gave no device set: %s", error.localizedDescription.UTF8String ?: "no reason");
  for (id device in send_object(set, "devices"))
    if ([[send_object(send_object(device, "UDID"), "UUIDString") uppercaseString] isEqualToString:udid.uppercaseString]) return device;
  refuse("this user's device set has no device %s", udid.UTF8String);
}

static id main_screen(id device) {
  for (id port in send_object(send_object(device, "io"), "ioPorts")) {
    id descriptor = send_object(port, "descriptor");
    Protocol *renderable = NSProtocolFromString(@"SimDisplayIOSurfaceRenderable");
    if (renderable && ![descriptor conformsToProtocol:renderable]) continue;
    if (![descriptor respondsToSelector:sel_registerName("framebufferSurface")]) continue;
    if (send_object(descriptor, "framebufferSurface")) return descriptor;
  }
  return nil;
}

static id wait_for_screen(id device, NSString *udid) {
  int64_t until = monotonic_us() + SCREEN_WAIT_US;
  for (;;) {
    id screen = main_screen(device);
    if (screen) return screen;
    if (monotonic_us() > until) refuse("the device %s showed no screen within %d s; is it booted?", udid.UTF8String, SCREEN_WAIT_US / 1000000);
    usleep(SCREEN_POLL_US);
  }
}

static void *read_commands(void *unused) {
  (void)unused;
  for (;;) {
    uint8_t command;
    if (read_all(&command, 1) != 0) exit(0);
    if (command == 'K') atomic_store(&key_wanted, 1);
    else if (command == 'Z') {
      uint32_t thousandths = read_u32();
      if (thousandths < 100 || thousandths > 1000) refuse("a scale must be 100 to 1000 thousandths, not %u", thousandths);
      atomic_store(&scale_wanted, (int)thousandths);
    } else refuse("unknown command byte 0x%02x while following a simulator", command);
  }
  return NULL;
}

static int scaled_side(size_t side, int thousandths) {
  return (int)((side * (size_t)thousandths + 500) / 1000) & ~1;
}

static void picture_from_surface(IOSurfaceRef surface, int thousandths, uint8_t **scratch, size_t *scratch_size) {
  size_t width = IOSurfaceGetWidth(surface), height = IOSurfaceGetHeight(surface), stride = IOSurfaceGetBytesPerRow(surface);
  int out_width = scaled_side(width, thousandths), out_height = scaled_side(height, thousandths);
  fit_picture(out_width, out_height);
  const uint8_t *base = IOSurfaceGetBaseAddress(surface);
  if (out_width == (int)(width & ~1) && out_height == (int)(height & ~1)) {
    bgra_to_i420(base, stride);
    return;
  }
  size_t needed = (size_t)out_width * out_height * 4;
  if (needed > *scratch_size) {
    free(*scratch);
    *scratch = malloc(needed);
    if (!*scratch) refuse("out of memory for a %dx%d frame", out_width, out_height);
    *scratch_size = needed;
  }
  vImage_Buffer from = {(void *)base, height, width, stride};
  vImage_Buffer to = {*scratch, (vImagePixelCount)out_height, (vImagePixelCount)out_width, (size_t)out_width * 4};
  vImage_Error scaled = vImageScale_ARGB8888(&from, &to, NULL, kvImageNoFlags);
  if (scaled != kvImageNoError) refuse("vImage could not scale a %zux%zu frame to %dx%d: %ld", width, height, out_width, out_height, (long)scaled);
  bgra_to_i420(*scratch, (size_t)out_width * 4);
}

int follow_simulator(const char *udid_text, const char *developer_given, int scale_thousandths) {
  @autoreleasepool {
    NSString *udid = @(udid_text);
    id device = device_with_udid(udid, developer_folder(developer_given));
    id screen = wait_for_screen(device, udid);
    atomic_store(&scale_wanted, scale_thousandths);
    pthread_t commands;
    if (pthread_create(&commands, NULL, read_commands, NULL) != 0) refuse("cannot start the command reader");
    IOSurfaceRef surface = (IOSurfaceRef)CFBridgingRetain(send_object(screen, "framebufferSurface"));
    int64_t surface_checked = monotonic_us(), interval = 1000000 / settings.fps, next = monotonic_us();
    uint32_t last_seed = 0;
    int scale = -1;
    uint8_t *scratch = NULL;
    size_t scratch_size = 0;
    for (;;) {
      @autoreleasepool {
        int64_t now = monotonic_us();
        if (next > now) usleep((useconds_t)(next - now));
        next = monotonic_us() + interval;
        if (monotonic_us() - surface_checked > SURFACE_RECHECK_US) {
          surface_checked = monotonic_us();
          id fresh = send_object(screen, "framebufferSurface");
          if (!fresh) screen = wait_for_screen(device, udid), fresh = send_object(screen, "framebufferSurface");
          if ((__bridge IOSurfaceRef)fresh != surface) {
            CFRelease(surface);
            surface = (IOSurfaceRef)CFBridgingRetain(fresh);
            last_seed = 0;
          }
        }
        int wanted_scale = atomic_load(&scale_wanted);
        int key = atomic_exchange(&key_wanted, 0);
        uint32_t seed = 0;
        if (IOSurfaceLock(surface, kIOSurfaceLockReadOnly, &seed) != kIOReturnSuccess) continue;
        int changed = seed != last_seed || wanted_scale != scale;
        int64_t started = monotonic_us();
        if (changed) {
          picture_from_surface(surface, wanted_scale, &scratch, &scratch_size);
          last_seed = seed;
          scale = wanted_scale;
          have_picture = 1;
        }
        IOSurfaceUnlock(surface, kIOSurfaceLockReadOnly, &seed);
        if (changed || (key && have_picture)) encode_picture(key, started);
      }
    }
  }
}
