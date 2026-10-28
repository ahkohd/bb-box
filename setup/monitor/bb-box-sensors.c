#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct IOReportSubscription *IOReportSubscriptionRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef matching);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
extern CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t timestamp);
extern double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);

extern CFDictionaryRef IOReportCopyChannelsInGroup(CFStringRef group, CFStringRef subgroup, uint64_t a, uint64_t b, uint64_t c);
extern IOReportSubscriptionRef IOReportCreateSubscription(void *allocator, CFMutableDictionaryRef channels, CFMutableDictionaryRef *subscribed, uint64_t channelId, CFTypeRef options);
extern CFDictionaryRef IOReportCreateSamples(IOReportSubscriptionRef subscription, CFMutableDictionaryRef channels, CFTypeRef options);
extern int64_t IOReportSimpleGetIntegerValue(CFDictionaryRef channel, int32_t index);
extern CFStringRef IOReportChannelGetChannelName(CFDictionaryRef channel);
extern CFStringRef IOReportChannelGetUnitLabel(CFDictionaryRef channel);

enum { TEMPERATURE_EVENT = 15, MIN_SAMPLE_MS = 250, MAX_SAMPLE_MS = 65000, MAX_KEYS = 256, ENERGY_RETRY_EVERY = 12 };

typedef struct { char major, minor, build, reserved; uint16_t release; } SmcVersion;
typedef struct { uint16_t version, length; uint32_t cpuLimit, gpuLimit, memoryLimit; } SmcLimits;
typedef struct { uint32_t dataSize, dataType; char dataAttributes; } SmcKeyInfo;
typedef struct {
  uint32_t key;
  SmcVersion version;
  SmcLimits limits;
  SmcKeyInfo keyInfo;
  char result, status, data8;
  uint32_t data32;
  unsigned char bytes[32];
} SmcCall;

enum { SMC_READ_KEY = 5, SMC_KEY_AT_INDEX = 8, SMC_KEY_INFO = 9, SMC_STRUCT_METHOD = 2 };

static uint32_t four_char_code(const char *text) {
  return ((uint32_t)text[0] << 24) | ((uint32_t)text[1] << 16) | ((uint32_t)text[2] << 8) | (uint32_t)text[3];
}

static int smc_call(io_connect_t connection, SmcCall *input, SmcCall *output) {
  size_t size = sizeof(SmcCall);
  memset(output, 0, sizeof(SmcCall));
  return IOConnectCallStructMethod(connection, SMC_STRUCT_METHOD, input, sizeof(SmcCall), output, &size) == KERN_SUCCESS && output->result == 0;
}

static int smc_key_info(io_connect_t connection, uint32_t key, SmcKeyInfo *info) {
  SmcCall input = {0}, output;
  input.key = key;
  input.data8 = SMC_KEY_INFO;
  if (!smc_call(connection, &input, &output)) return 0;
  *info = output.keyInfo;
  return 1;
}

static int smc_read(io_connect_t connection, uint32_t key, SmcKeyInfo info, unsigned char *bytes) {
  SmcCall input = {0}, output;
  input.key = key;
  input.keyInfo.dataSize = info.dataSize;
  input.data8 = SMC_READ_KEY;
  if (!smc_call(connection, &input, &output)) return 0;
  memcpy(bytes, output.bytes, sizeof output.bytes);
  return 1;
}

static int name_has(const char *name, const char *needle) {
  return strstr(name, needle) != NULL;
}

static int number_dictionary_entry(CFMutableDictionaryRef dictionary, const char *key, int value) {
  CFStringRef cfKey = CFStringCreateWithCString(NULL, key, kCFStringEncodingUTF8);
  CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &value);
  CFDictionarySetValue(dictionary, cfKey, number);
  CFRelease(cfKey);
  CFRelease(number);
  return 0;
}

static IOHIDEventSystemClientRef open_hid_temperatures(void) {
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) return NULL;
  CFMutableDictionaryRef matching = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  number_dictionary_entry(matching, "PrimaryUsagePage", 0xff00);
  number_dictionary_entry(matching, "PrimaryUsage", 5);
  IOHIDEventSystemClientSetMatching(client, matching);
  CFRelease(matching);
  return client;
}

static void read_hid_temperatures(IOHIDEventSystemClientRef client, double *cpu, double *gpu) {
  double cpuSum = 0, gpuSum = 0;
  int cpuCount = 0, gpuCount = 0;
  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  if (services) {
    for (CFIndex index = 0; index < CFArrayGetCount(services); index++) {
      IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, index);
      CFTypeRef product = IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
      char name[128] = "";
      if (product && CFGetTypeID(product) == CFStringGetTypeID()) {
        CFStringGetCString((CFStringRef)product, name, sizeof name, kCFStringEncodingUTF8);
      }
      if (product) CFRelease(product);
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, TEMPERATURE_EVENT, 0, 0);
      if (!event) continue;
      double celsius = IOHIDEventGetFloatValue(event, TEMPERATURE_EVENT << 16);
      CFRelease(event);
      if (!(celsius > 0 && celsius <= 150)) continue;
      if (name_has(name, "tdie") || name_has(name, "pACC") || name_has(name, "eACC")) {
        cpuSum += celsius;
        cpuCount++;
      } else if (name_has(name, "GPU")) {
        gpuSum += celsius;
        gpuCount++;
      }
    }
    CFRelease(services);
  }
  if (cpuCount) *cpu = cpuSum / cpuCount;
  if (gpuCount) *gpu = gpuSum / gpuCount;
}

static double joules(int64_t value, CFStringRef unit) {
  char label[16] = "";
  if (unit) CFStringGetCString(unit, label, sizeof label, kCFStringEncodingUTF8);
  if (strcmp(label, "mJ") == 0) return value / 1e3;
  if (strcmp(label, "uJ") == 0) return value / 1e6;
  if (strcmp(label, "nJ") == 0) return value / 1e9;
  return -1;
}

typedef struct {
  io_connect_t smc;
  uint32_t keys[MAX_KEYS];
  SmcKeyInfo keyInfos[MAX_KEYS];
  int keyCount;
  IOHIDEventSystemClientRef hid;
  CFDictionaryRef channels;
  CFMutableDictionaryRef mutableChannels;
  CFMutableDictionaryRef subscribed;
  IOReportSubscriptionRef subscription;
  CFDictionaryRef previous;
  uint64_t previousAt;
  int energyRetryIn;
} Sampler;

static int is_temperature_key(uint32_t key) {
  char kind = (char)(key >> 16);
  return (char)(key >> 24) == 'T' && (kind == 'p' || kind == 'e' || kind == 'g');
}

static void find_temperature_keys(Sampler *sampler) {
  SmcKeyInfo countInfo;
  unsigned char bytes[32];
  uint32_t total = 0;
  if (smc_key_info(sampler->smc, four_char_code("#KEY"), &countInfo) && smc_read(sampler->smc, four_char_code("#KEY"), countInfo, bytes)) {
    total = ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | bytes[3];
  }
  for (uint32_t index = 0; index < total && sampler->keyCount < MAX_KEYS; index++) {
    SmcCall input = {0}, output;
    input.data8 = SMC_KEY_AT_INDEX;
    input.data32 = index;
    if (!smc_call(sampler->smc, &input, &output) || !is_temperature_key(output.key)) continue;
    SmcKeyInfo info;
    if (!smc_key_info(sampler->smc, output.key, &info) || info.dataType != four_char_code("flt ") || info.dataSize != 4) continue;
    sampler->keys[sampler->keyCount] = output.key;
    sampler->keyInfos[sampler->keyCount] = info;
    sampler->keyCount++;
  }
}

static void open_smc(Sampler *sampler) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!service) return;
  if (IOServiceOpen(service, mach_task_self(), 0, &sampler->smc) != KERN_SUCCESS) sampler->smc = 0;
  IOObjectRelease(service);
  if (sampler->smc) find_temperature_keys(sampler);
}

static void read_smc_temperatures(Sampler *sampler, double *cpu, double *gpu) {
  double cpuSum = 0, gpuSum = 0;
  int cpuCount = 0, gpuCount = 0;
  for (int index = 0; index < sampler->keyCount; index++) {
    uint32_t key = sampler->keys[index];
    unsigned char bytes[32];
    if (!smc_read(sampler->smc, key, sampler->keyInfos[index], bytes)) continue;
    float celsius;
    memcpy(&celsius, bytes, sizeof celsius);
    if (!(celsius > 0 && celsius <= 150) || celsius == (float)(int)celsius) continue;
    if ((char)(key >> 16) == 'g') { gpuSum += celsius; gpuCount++; }
    else { cpuSum += celsius; cpuCount++; }
  }
  if (cpuCount) *cpu = cpuSum / cpuCount;
  if (gpuCount) *gpu = gpuSum / gpuCount;
}

static uint64_t now_ns(void) {
  return clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);
}

static void release_energy(Sampler *sampler) {
  if (sampler->subscription) CFRelease((CFTypeRef)sampler->subscription);
  if (sampler->subscribed) CFRelease(sampler->subscribed);
  if (sampler->mutableChannels) CFRelease(sampler->mutableChannels);
  if (sampler->channels) CFRelease(sampler->channels);
  sampler->subscription = NULL;
  sampler->subscribed = NULL;
  sampler->mutableChannels = NULL;
  sampler->channels = NULL;
}

static int subscribe_energy(Sampler *sampler) {
  sampler->channels = IOReportCopyChannelsInGroup(CFSTR("Energy Model"), NULL, 0, 0, 0);
  if (sampler->channels) {
    sampler->mutableChannels = CFDictionaryCreateMutableCopy(NULL, 0, sampler->channels);
    sampler->subscription = IOReportCreateSubscription(NULL, sampler->mutableChannels, &sampler->subscribed, 0, NULL);
  }
  if (sampler->subscription && sampler->subscribed) return 1;
  release_energy(sampler);
  return 0;
}

static void take_energy_baseline(Sampler *sampler) {
  sampler->previous = IOReportCreateSamples(sampler->subscription, sampler->subscribed, NULL);
  sampler->previousAt = now_ns();
}

static void read_power(Sampler *sampler, double *cpu, double *gpu) {
  if (!sampler->subscription) {
    if (sampler->energyRetryIn-- > 0) return;
    sampler->energyRetryIn = ENERGY_RETRY_EVERY;
    if (!subscribe_energy(sampler)) return;
  }
  if (!sampler->previous) {
    take_energy_baseline(sampler);
    return;
  }
  uint64_t elapsedMs = (now_ns() - sampler->previousAt) / 1000000;
  if (elapsedMs < MIN_SAMPLE_MS) return;
  if (elapsedMs > MAX_SAMPLE_MS) {
    CFRelease(sampler->previous);
    take_energy_baseline(sampler);
    return;
  }
  CFDictionaryRef current = IOReportCreateSamples(sampler->subscription, sampler->subscribed, NULL);
  uint64_t currentAt = now_ns();
  if (!current) return;
  double seconds = (currentAt - sampler->previousAt) / 1e9;
  CFArrayRef before = CFDictionaryGetValue(sampler->previous, CFSTR("IOReportChannels"));
  CFArrayRef after = CFDictionaryGetValue(current, CFSTR("IOReportChannels"));
  CFIndex count = before && after && CFArrayGetCount(before) == CFArrayGetCount(after) ? CFArrayGetCount(after) : 0;
  double cpuJoules = 0, gpuJoules = 0, gpuFallbackJoules = 0;
  int cpuSeen = 0, gpuSeen = 0, gpuFallbackSeen = 0;
  for (CFIndex index = 0; index < count; index++) {
    CFDictionaryRef start = CFArrayGetValueAtIndex(before, index);
    CFDictionaryRef end = CFArrayGetValueAtIndex(after, index);
    char name[128] = "";
    CFStringRef channelName = IOReportChannelGetChannelName(end);
    if (channelName) CFStringGetCString(channelName, name, sizeof name, kCFStringEncodingUTF8);
    double energy = joules(IOReportSimpleGetIntegerValue(end, 0) - IOReportSimpleGetIntegerValue(start, 0), IOReportChannelGetUnitLabel(end));
    if (energy < 0) continue;
    if (strcmp(name, "GPU Energy") == 0) {
      gpuJoules += energy;
      gpuSeen = 1;
    } else if (strcmp(name, "GPU") == 0) {
      gpuFallbackJoules += energy;
      gpuFallbackSeen = 1;
    } else if (name_has(name, "CPU Energy")) {
      cpuJoules += energy;
      cpuSeen = 1;
    }
  }
  if (!gpuSeen && gpuFallbackSeen) {
    gpuJoules = gpuFallbackJoules;
    gpuSeen = 1;
  }
  if (cpuSeen && cpuJoules > 0 && seconds > 0) *cpu = cpuJoules / seconds;
  if (gpuSeen && gpuJoules > 0 && seconds > 0) *gpu = gpuJoules / seconds;
  CFRelease(sampler->previous);
  sampler->previous = current;
  sampler->previousAt = currentAt;
}

static double read_gpu_utilization(void) {
  io_iterator_t accelerators;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &accelerators) != KERN_SUCCESS) return -1;
  double percent = -1;
  io_object_t accelerator;
  while ((accelerator = IOIteratorNext(accelerators))) {
    CFTypeRef statistics = IORegistryEntryCreateCFProperty(accelerator, CFSTR("PerformanceStatistics"), kCFAllocatorDefault, 0);
    if (statistics && CFGetTypeID(statistics) == CFDictionaryGetTypeID() && percent < 0) {
      CFTypeRef utilization = CFDictionaryGetValue(statistics, CFSTR("Device Utilization %"));
      int value;
      if (utilization && CFGetTypeID(utilization) == CFNumberGetTypeID() && CFNumberGetValue(utilization, kCFNumberIntType, &value)) percent = value;
    }
    if (statistics) CFRelease(statistics);
    IOObjectRelease(accelerator);
  }
  IOObjectRelease(accelerators);
  return percent;
}

static void print_number(const char *key, double value, const char *separator) {
  if (!isfinite(value) || value < 0) printf("\"%s\":null%s", key, separator);
  else printf("\"%s\":%.2f%s", key, value, separator);
}

static void print_reading(Sampler *sampler) {
  double cpuTemp = -1, gpuTemp = -1, cpuWatts = -1, gpuWatts = -1;
  if (sampler->smc) read_smc_temperatures(sampler, &cpuTemp, &gpuTemp);
  if (cpuTemp < 0) {
    if (!sampler->hid) sampler->hid = open_hid_temperatures();
    if (sampler->hid) read_hid_temperatures(sampler->hid, &cpuTemp, &gpuTemp);
  }
  read_power(sampler, &cpuWatts, &gpuWatts);
  printf("{");
  print_number("cpuTempC", cpuTemp, ",");
  print_number("gpuTempC", gpuTemp, ",");
  print_number("cpuWatts", cpuWatts, ",");
  print_number("gpuWatts", gpuWatts, ",");
  print_number("gpuPercent", read_gpu_utilization(), "");
  printf("}\n");
  fflush(stdout);
}

int main(void) {
  Sampler sampler = {0};
  open_smc(&sampler);
  if (subscribe_energy(&sampler)) take_energy_baseline(&sampler);
  char request[64];
  while (fgets(request, sizeof request, stdin)) print_reading(&sampler);
  return 0;
}
