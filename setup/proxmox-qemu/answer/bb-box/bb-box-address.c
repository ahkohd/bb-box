#define _CRT_SECURE_NO_WARNINGS
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <iphlpapi.h>
#include <netioapi.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "iphlpapi.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "advapi32.lib")

#define BOOT_LOG_PATH "C:\\bb-box\\boot.log"
#define DNS_LIST_PATH "C:\\bb-box\\dns.txt"
#define DEFAULT_DNS_COMMA "1.1.1.1,9.9.9.9"
#define DEFAULT_DNS_SPACE "1.1.1.1 9.9.9.9"
#define SERVICE_NAME L"bb-box-address"
#define SMBIOS_FIRMWARE_PROVIDER 0x52534D42u
#define SMBIOS_SYSTEM_INFO_TYPE 1
#define SMBIOS_SERIAL_OFFSET 7
#define ADAPTER_WAIT_ATTEMPTS 600
#define ADAPTER_POLL_MS 50
#define MAX_DNS_SERVERS 8
#define DHCP_DISABLE_ACTION 2

typedef struct {
  BYTE used20CallingMethod;
  BYTE smbiosMajorVersion;
  BYTE smbiosMinorVersion;
  BYTE dmiRevision;
  DWORD length;
  BYTE tableData[1];
} RawSmbiosData;

typedef DWORD(WINAPI *DhcpNotifyConfigChangeFn)(
  LPWSTR serverName,
  LPWSTR adapterName,
  BOOL isNewIpAddress,
  DWORD ipIndex,
  DWORD ipAddress,
  DWORD subnetMask,
  int dhcpAction
);

static SERVICE_STATUS_HANDLE serviceStatusHandle = NULL;
static SERVICE_STATUS serviceStatus;

static void appendBootLog(const char *format, ...) {
  SYSTEMTIME utcNow;
  GetSystemTime(&utcNow);
  double uptimeSeconds = (double)GetTickCount64() / 1000.0;

  char message[512];
  va_list args;
  va_start(args, format);
  vsnprintf(message, sizeof(message), format, args);
  va_end(args);

  FILE *file = fopen(BOOT_LOG_PATH, "a");
  if (!file) return;
  fprintf(
    file,
    "%04u-%02u-%02uT%02u:%02u:%02u.%03u+00:00 +%.1fs %s\n",
    utcNow.wYear,
    utcNow.wMonth,
    utcNow.wDay,
    utcNow.wHour,
    utcNow.wMinute,
    utcNow.wSecond,
    utcNow.wMilliseconds,
    uptimeSeconds,
    message
  );
  fclose(file);
}

static int readSmbiosSerial(char *out, size_t capacity) {
  UINT size = GetSystemFirmwareTable(SMBIOS_FIRMWARE_PROVIDER, 0, NULL, 0);
  if (size < sizeof(RawSmbiosData)) return 0;

  BYTE *buffer = (BYTE *)malloc(size);
  if (!buffer) return 0;

  int found = 0;
  if (GetSystemFirmwareTable(SMBIOS_FIRMWARE_PROVIDER, 0, buffer, size) == size) {
    RawSmbiosData *raw = (RawSmbiosData *)buffer;
    BYTE *cursor = raw->tableData;
    BYTE *end = cursor + raw->length;
    if (end > buffer + size) end = buffer + size;

    while (cursor + 4 <= end) {
      BYTE type = cursor[0];
      BYTE formattedLength = cursor[1];
      if (formattedLength < 4 || cursor + formattedLength > end) break;

      BYTE *strings = cursor + formattedLength;
      BYTE *terminator = strings;
      while (terminator + 1 < end && !(terminator[0] == 0 && terminator[1] == 0)) terminator++;
      if (terminator + 2 > end) break;

      if (type == SMBIOS_SYSTEM_INFO_TYPE && formattedLength > SMBIOS_SERIAL_OFFSET) {
        BYTE targetIndex = cursor[SMBIOS_SERIAL_OFFSET];
        if (targetIndex > 0) {
          BYTE currentIndex = 1;
          BYTE *entry = strings;
          while (entry < terminator) {
            if (currentIndex == targetIndex) {
              size_t entryLength = strnlen((const char *)entry, (size_t)(terminator - entry));
              if (entryLength >= capacity) entryLength = capacity - 1;
              memcpy(out, entry, entryLength);
              out[entryLength] = '\0';
              found = 1;
              break;
            }
            while (entry < terminator && *entry) entry++;
            if (entry < terminator) entry++;
            currentIndex++;
          }
        }
        break;
      }

      cursor = terminator + 2;
    }
  }

  free(buffer);
  return found;
}

static int parseSmbiosAddress(
  const char *serial,
  char *ipText,
  size_t ipCapacity,
  IN_ADDR *ipAddr,
  int *prefixLength,
  char *gatewayText,
  size_t gatewayCapacity,
  IN_ADDR *gatewayAddr
) {
  char copy[256];
  strncpy(copy, serial, sizeof(copy) - 1);
  copy[sizeof(copy) - 1] = '\0';

  char *space = strchr(copy, ' ');
  if (!space || strchr(space + 1, ' ') != NULL) return 0;
  *space = '\0';

  char *cidr = copy;
  char *gateway = space + 1;
  char *slash = strchr(cidr, '/');
  if (!slash) return 0;
  *slash = '\0';

  char *endPtr = NULL;
  long parsedPrefix = strtol(slash + 1, &endPtr, 10);
  if (!endPtr || *endPtr != '\0' || parsedPrefix < 1 || parsedPrefix > 32) return 0;
  if (inet_pton(AF_INET, cidr, ipAddr) != 1) return 0;
  if (inet_pton(AF_INET, gateway, gatewayAddr) != 1) return 0;

  strncpy(ipText, cidr, ipCapacity - 1);
  ipText[ipCapacity - 1] = '\0';
  strncpy(gatewayText, gateway, gatewayCapacity - 1);
  gatewayText[gatewayCapacity - 1] = '\0';
  *prefixLength = (int)parsedPrefix;
  return 1;
}

static void readDnsServers(char *commaSeparated, size_t commaCapacity, char *spaceSeparated, size_t spaceCapacity) {
  commaSeparated[0] = '\0';
  spaceSeparated[0] = '\0';

  FILE *file = fopen(DNS_LIST_PATH, "r");
  if (file) {
    char buffer[512];
    size_t readCount = fread(buffer, 1, sizeof(buffer) - 1, file);
    fclose(file);
    buffer[readCount] = '\0';

    int added = 0;
    char *token = strtok(buffer, " \t\r\n,;");
    while (token && added < MAX_DNS_SERVERS) {
      IN_ADDR parsed;
      if (inet_pton(AF_INET, token, &parsed) == 1) {
        if (added > 0) {
          strncat(commaSeparated, ",", commaCapacity - strlen(commaSeparated) - 1);
          strncat(spaceSeparated, " ", spaceCapacity - strlen(spaceSeparated) - 1);
        }
        strncat(commaSeparated, token, commaCapacity - strlen(commaSeparated) - 1);
        strncat(spaceSeparated, token, spaceCapacity - strlen(spaceSeparated) - 1);
        added++;
      }
      token = strtok(NULL, " \t\r\n,;");
    }
  }

  if (!commaSeparated[0]) {
    strncpy(commaSeparated, DEFAULT_DNS_COMMA, commaCapacity - 1);
    commaSeparated[commaCapacity - 1] = '\0';
    strncpy(spaceSeparated, DEFAULT_DNS_SPACE, spaceCapacity - 1);
    spaceSeparated[spaceCapacity - 1] = '\0';
  }
}

static void prefixToSubnetMask(int prefixLength, char *out, size_t capacity) {
  ULONG mask = prefixLength == 0 ? 0 : (~0UL << (32 - prefixLength));
  snprintf(
    out,
    capacity,
    "%lu.%lu.%lu.%lu",
    (mask >> 24) & 0xFF,
    (mask >> 16) & 0xFF,
    (mask >> 8) & 0xFF,
    mask & 0xFF
  );
}

static void formatInterfaceGuid(const GUID *guid, char *out, size_t capacity) {
  snprintf(
    out,
    capacity,
    "{%08lX-%04X-%04X-%02X%02X-%02X%02X%02X%02X%02X%02X}",
    (unsigned long)guid->Data1,
    guid->Data2,
    guid->Data3,
    guid->Data4[0],
    guid->Data4[1],
    guid->Data4[2],
    guid->Data4[3],
    guid->Data4[4],
    guid->Data4[5],
    guid->Data4[6],
    guid->Data4[7]
  );
}

static void tcpipInterfaceRegistryPath(const GUID *guid, char *out, size_t capacity) {
  char guidText[64];
  formatInterfaceGuid(guid, guidText, sizeof(guidText));
  snprintf(out, capacity, "SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\%s", guidText);
}

static int isDhcpDisabledInRegistry(const GUID *guid) {
  char path[256];
  tcpipInterfaceRegistryPath(guid, path, sizeof(path));

  HKEY key = NULL;
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, path, 0, KEY_READ, &key) != ERROR_SUCCESS) return 0;

  DWORD value = 1;
  DWORD valueSize = sizeof(value);
  DWORD valueType = 0;
  LONG rc = RegQueryValueExA(key, "EnableDHCP", NULL, &valueType, (BYTE *)&value, &valueSize);
  RegCloseKey(key);
  return rc == ERROR_SUCCESS && valueType == REG_DWORD && value == 0;
}

static void writeMultiStringValue(HKEY key, const char *name, const char *singleValue) {
  char buffer[64];
  size_t length = strlen(singleValue);
  if (length + 2 > sizeof(buffer)) length = sizeof(buffer) - 2;
  memcpy(buffer, singleValue, length);
  buffer[length] = '\0';
  buffer[length + 1] = '\0';
  RegSetValueExA(key, name, 0, REG_MULTI_SZ, (const BYTE *)buffer, (DWORD)(length + 2));
}

static void persistStaticConfigInRegistry(
  const GUID *guid,
  const char *ipText,
  const char *maskText,
  const char *gatewayText,
  const char *dnsComma
) {
  char path[256];
  tcpipInterfaceRegistryPath(guid, path, sizeof(path));

  HKEY key = NULL;
  if (RegOpenKeyExA(HKEY_LOCAL_MACHINE, path, 0, KEY_SET_VALUE, &key) != ERROR_SUCCESS) return;

  DWORD dhcpOff = 0;
  RegSetValueExA(key, "EnableDHCP", 0, REG_DWORD, (const BYTE *)&dhcpOff, sizeof(dhcpOff));
  writeMultiStringValue(key, "IPAddress", ipText);
  writeMultiStringValue(key, "SubnetMask", maskText);
  writeMultiStringValue(key, "DefaultGateway", gatewayText);
  writeMultiStringValue(key, "DefaultGatewayMetric", "1");
  RegSetValueExA(key, "NameServer", 0, REG_SZ, (const BYTE *)dnsComma, (DWORD)(strlen(dnsComma) + 1));
  RegCloseKey(key);
}

static int hasPreferredStaticAddress(
  const NET_LUID *luid,
  const GUID *guid,
  const IN_ADDR *ipAddr,
  int prefixLength,
  const IN_ADDR *gatewayAddr
) {
  if (!isDhcpDisabledInRegistry(guid)) return 0;

  int hasAddress = 0;
  PMIB_UNICASTIPADDRESS_TABLE addressTable = NULL;
  if (GetUnicastIpAddressTable(AF_INET, &addressTable) == NO_ERROR) {
    for (ULONG i = 0; i < addressTable->NumEntries; i++) {
      MIB_UNICASTIPADDRESS_ROW *row = &addressTable->Table[i];
      if (row->InterfaceLuid.Value == luid->Value &&
          row->Address.Ipv4.sin_addr.s_addr == ipAddr->s_addr &&
          row->OnLinkPrefixLength == (UINT8)prefixLength &&
          row->DadState == IpDadStatePreferred) {
        hasAddress = 1;
        break;
      }
    }
    FreeMibTable(addressTable);
  }
  if (!hasAddress) return 0;

  int hasGateway = 0;
  PMIB_IPFORWARD_TABLE2 routeTable = NULL;
  if (GetIpForwardTable2(AF_INET, &routeTable) == NO_ERROR) {
    for (ULONG i = 0; i < routeTable->NumEntries; i++) {
      MIB_IPFORWARD_ROW2 *row = &routeTable->Table[i];
      if (row->InterfaceLuid.Value == luid->Value &&
          row->DestinationPrefix.PrefixLength == 0 &&
          row->DestinationPrefix.Prefix.Ipv4.sin_addr.s_addr == 0 &&
          row->NextHop.Ipv4.sin_addr.s_addr == gatewayAddr->s_addr) {
        hasGateway = 1;
        break;
      }
    }
    FreeMibTable(routeTable);
  }
  return hasGateway;
}

static int waitForPhysicalEthernet(NET_LUID *luid, GUID *guid, NET_IFINDEX *ifIndex) {
  for (int attempt = 0; attempt < ADAPTER_WAIT_ATTEMPTS; attempt++) {
    PMIB_IF_TABLE2 table = NULL;
    if (GetIfTable2(&table) == NO_ERROR) {
      for (ULONG i = 0; i < table->NumEntries; i++) {
        MIB_IF_ROW2 *row = &table->Table[i];
        if (row->InterfaceAndOperStatusFlags.HardwareInterface &&
            row->Type == IF_TYPE_ETHERNET_CSMACD &&
            row->OperStatus == IfOperStatusUp) {
          *luid = row->InterfaceLuid;
          *guid = row->InterfaceGuid;
          *ifIndex = row->InterfaceIndex;
          FreeMibTable(table);
          return 1;
        }
      }
      FreeMibTable(table);
    }
    Sleep(ADAPTER_POLL_MS);
  }
  return 0;
}

static void disableIpv4Dad(const NET_LUID *luid) {
  MIB_IPINTERFACE_ROW ipInterface;
  InitializeIpInterfaceEntry(&ipInterface);
  ipInterface.Family = AF_INET;
  ipInterface.InterfaceLuid = *luid;
  if (GetIpInterfaceEntry(&ipInterface) != NO_ERROR) return;

  ipInterface.SitePrefixLength = 0;
  ipInterface.DadTransmits = 0;
  SetIpInterfaceEntry(&ipInterface);
}

static void clearExistingIpv4Config(const NET_LUID *luid) {
  PMIB_UNICASTIPADDRESS_TABLE addressTable = NULL;
  if (GetUnicastIpAddressTable(AF_INET, &addressTable) == NO_ERROR) {
    for (ULONG i = 0; i < addressTable->NumEntries; i++) {
      if (addressTable->Table[i].InterfaceLuid.Value == luid->Value) {
        DeleteUnicastIpAddressEntry(&addressTable->Table[i]);
      }
    }
    FreeMibTable(addressTable);
  }

  PMIB_IPFORWARD_TABLE2 routeTable = NULL;
  if (GetIpForwardTable2(AF_INET, &routeTable) == NO_ERROR) {
    for (ULONG i = 0; i < routeTable->NumEntries; i++) {
      MIB_IPFORWARD_ROW2 *row = &routeTable->Table[i];
      if (row->InterfaceLuid.Value == luid->Value && row->DestinationPrefix.PrefixLength == 0) {
        DeleteIpForwardEntry2(row);
      }
    }
    FreeMibTable(routeTable);
  }
}

static void notifyDhcpDisabled(const GUID *guid) {
  HMODULE dhcpLibrary = LoadLibraryW(L"dhcpcsvc.dll");
  if (!dhcpLibrary) return;

  DhcpNotifyConfigChangeFn notify = (DhcpNotifyConfigChangeFn)GetProcAddress(dhcpLibrary, "DhcpNotifyConfigChange");
  if (notify) {
    char guidText[64];
    wchar_t wideGuid[64];
    formatInterfaceGuid(guid, guidText, sizeof(guidText));
    MultiByteToWideChar(CP_UTF8, 0, guidText, -1, wideGuid, 64);
    notify(NULL, wideGuid, FALSE, 0, 0, 0, DHCP_DISABLE_ACTION);
  }

  FreeLibrary(dhcpLibrary);
}

static int configureAddressFromSmbios(void) {
  char serial[256] = {0};
  if (!readSmbiosSerial(serial, sizeof(serial))) {
    appendBootLog("no address in the SMBIOS serial");
    return 0;
  }

  char ipText[64];
  char gatewayText[64];
  IN_ADDR ipAddr;
  IN_ADDR gatewayAddr;
  int prefixLength = 0;
  if (!parseSmbiosAddress(serial, ipText, sizeof(ipText), &ipAddr, &prefixLength, gatewayText, sizeof(gatewayText), &gatewayAddr)) {
    appendBootLog("no address in the SMBIOS serial");
    return 0;
  }

  char dnsComma[256];
  char dnsSpace[256];
  readDnsServers(dnsComma, sizeof(dnsComma), dnsSpace, sizeof(dnsSpace));
  appendBootLog("started: %s/%d via %s", ipText, prefixLength, gatewayText);

  NET_LUID luid = {0};
  GUID guid = {0};
  NET_IFINDEX ifIndex = 0;
  if (!waitForPhysicalEthernet(&luid, &guid, &ifIndex)) {
    appendBootLog("no network adapter came up");
    return 1;
  }
  appendBootLog("adapter %lu is up", (unsigned long)ifIndex);

  if (hasPreferredStaticAddress(&luid, &guid, &ipAddr, prefixLength, &gatewayAddr)) {
    appendBootLog("address %s already set", ipText);
    return 0;
  }

  disableIpv4Dad(&luid);

  char maskText[32];
  prefixToSubnetMask(prefixLength, maskText, sizeof(maskText));
  persistStaticConfigInRegistry(&guid, ipText, maskText, gatewayText, dnsComma);
  clearExistingIpv4Config(&luid);

  MIB_UNICASTIPADDRESS_ROW unicastRow;
  InitializeUnicastIpAddressEntry(&unicastRow);
  unicastRow.InterfaceLuid = luid;
  unicastRow.Address.si_family = AF_INET;
  unicastRow.Address.Ipv4.sin_family = AF_INET;
  unicastRow.Address.Ipv4.sin_addr = ipAddr;
  unicastRow.OnLinkPrefixLength = (UINT8)prefixLength;
  unicastRow.PrefixOrigin = IpPrefixOriginManual;
  unicastRow.SuffixOrigin = IpSuffixOriginManual;
  unicastRow.ValidLifetime = 0xffffffff;
  unicastRow.PreferredLifetime = 0xffffffff;

  DWORD rc = CreateUnicastIpAddressEntry(&unicastRow);
  if (rc != NO_ERROR && rc != ERROR_OBJECT_ALREADY_EXISTS) {
    appendBootLog("CreateUnicastIpAddressEntry failed (%lu)", (unsigned long)rc);
    return 1;
  }

  MIB_IPFORWARD_ROW2 routeRow;
  InitializeIpForwardEntry(&routeRow);
  routeRow.InterfaceLuid = luid;
  routeRow.DestinationPrefix.Prefix.si_family = AF_INET;
  routeRow.DestinationPrefix.Prefix.Ipv4.sin_family = AF_INET;
  routeRow.DestinationPrefix.Prefix.Ipv4.sin_addr.s_addr = 0;
  routeRow.DestinationPrefix.PrefixLength = 0;
  routeRow.NextHop.si_family = AF_INET;
  routeRow.NextHop.Ipv4.sin_family = AF_INET;
  routeRow.NextHop.Ipv4.sin_addr = gatewayAddr;
  routeRow.Metric = 1;
  routeRow.Protocol = MIB_IPPROTO_NETMGMT;

  rc = CreateIpForwardEntry2(&routeRow);
  if (rc != NO_ERROR && rc != ERROR_OBJECT_ALREADY_EXISTS) {
    appendBootLog("CreateIpForwardEntry2 failed (%lu)", (unsigned long)rc);
    return 1;
  }

  wchar_t wideDns[256];
  MultiByteToWideChar(CP_UTF8, 0, dnsComma, -1, wideDns, 256);
  DNS_INTERFACE_SETTINGS dnsSettings;
  memset(&dnsSettings, 0, sizeof(dnsSettings));
  dnsSettings.Version = DNS_INTERFACE_SETTINGS_VERSION1;
  dnsSettings.Flags = DNS_SETTING_NAMESERVER;
  dnsSettings.NameServer = wideDns;
  SetInterfaceDnsSettings(guid, &dnsSettings);

  notifyDhcpDisabled(&guid);
  appendBootLog("address %s/%d, gateway %s, DNS %s", ipText, prefixLength, gatewayText, dnsSpace);
  return 0;
}

static void WINAPI handleServiceControl(DWORD controlCode) {
  if (controlCode == SERVICE_CONTROL_STOP || controlCode == SERVICE_CONTROL_SHUTDOWN) {
    serviceStatus.dwCurrentState = SERVICE_STOPPED;
    SetServiceStatus(serviceStatusHandle, &serviceStatus);
  }
}

static void WINAPI runServiceMain(DWORD argc, LPWSTR *argv) {
  (void)argc;
  (void)argv;
  serviceStatusHandle = RegisterServiceCtrlHandlerW(SERVICE_NAME, handleServiceControl);
  if (!serviceStatusHandle) return;

  memset(&serviceStatus, 0, sizeof(serviceStatus));
  serviceStatus.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  serviceStatus.dwCurrentState = SERVICE_RUNNING;
  serviceStatus.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN;
  SetServiceStatus(serviceStatusHandle, &serviceStatus);

  int exitCode = configureAddressFromSmbios();

  serviceStatus.dwCurrentState = SERVICE_STOPPED;
  serviceStatus.dwWin32ExitCode = exitCode ? ERROR_SERVICE_SPECIFIC_ERROR : NO_ERROR;
  serviceStatus.dwServiceSpecificExitCode = (DWORD)exitCode;
  SetServiceStatus(serviceStatusHandle, &serviceStatus);
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "--service") == 0) {
    SERVICE_TABLE_ENTRYW dispatchTable[] = {
      { SERVICE_NAME, runServiceMain },
      { NULL, NULL }
    };
    StartServiceCtrlDispatcherW(dispatchTable);
    return 0;
  }
  return configureAddressFromSmbios();
}
