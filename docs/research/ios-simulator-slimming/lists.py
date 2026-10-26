#!/usr/bin/env python3
import sys

KEEP = {
    "com.apple.SpringBoard": "the device's home screen and app launches",
    "com.apple.backboardd": "touches, display and HID events",
    "com.apple.CoreSimulator.bridge": "simctl's way into the device: pasteboard, openurl, push, location",
    "com.apple.runningboardd": "app lifecycle",
    "com.apple.InputUI": "the software keyboard",
    "com.apple.pasteboard.pasted": "the pasteboard",
    "com.apple.tccd": "privacy grants",
    "com.apple.locationd": "location",
    "com.apple.usernotificationsd": "notifications, simctl push",
    "com.apple.bulletindistributord": "notification delivery",
    "com.apple.donotdisturbd": "Focus, which notifications consult",
    "com.apple.mobile.installd": "app install",
    "com.apple.MobileInstallationHelperService": "app install",
    "com.apple.installcoordinationd": "app install",
    "com.apple.containermanagerd": "app containers",
    "com.apple.lsd": "launch services",
    "com.apple.iconservices.iconservicesagent": "app icons",
    "com.apple.cfprefsd.xpc.daemon": "preferences",
    "com.apple.distnoted.xpc.daemon": "notifications between processes",
    "com.apple.configd_sim": "network configuration",
    "com.apple.UserEventAgent-System": "system events",
    "com.apple.securityd": "keychain",
    "com.apple.trustd": "certificate trust, for HTTPS",
    "com.apple.nsurlsessiond": "background URL sessions for apps",
    "com.apple.syslogd": "logging",
    "com.apple.aslmanager": "logging",
    "com.apple.AccessibilityUIServer": "accessibility",
    "com.apple.accessibility.axassetsd": "accessibility assets",
    "com.apple.fontservicesd": "fonts",
    "com.apple.FileCoordination": "files",
    "com.apple.FileProvider": "document pickers",
    "com.apple.pluginkit.pkd": "extensions, keyboards among them",
    "com.apple.dasd": "background task scheduling for apps",
    "com.apple.swcd": "associated domains and universal links",
    "com.apple.revisiond": "file versions",
    "com.apple.GSSCred": "credentials",
    "com.apple.accountsd": "accounts store, read by many frameworks",
    "com.apple.mobileassetd": "assets such as keyboard dictionaries and fonts",
    "com.apple.managedconfiguration.profiled": "restrictions, which the keyboard and paste consult",
    "com.apple.systemstatusd": "status bar",
    "com.apple.countryd": "region",
    "com.apple.localizationswitcherd": "language",
    "com.apple.featureaccessd": "feature checks",
    "com.apple.appprotectiond": "app lock checks at launch",
    "com.apple.geod": "MapKit tiles in apps",
    "com.apple.assetsd": "the photo library for pickers",
    "com.apple.contactsd": "contacts for apps",
    "com.apple.calaccessd": "calendars for apps",
    "com.apple.WebBookmarks.webbookmarksd": "Safari",
    "com.apple.devicecheckd": "DeviceCheck and App Attest for apps",
    "com.apple.AuthenticationServicesCore.AuthenticationServicesAgent": "sign-in sheets and passkeys",
    "com.apple.mediaremoted": "now playing, media keys",
    "com.apple.nanoregistryd": "simctl bootstatus never reports the device booted without it",
    "com.apple.sleepd": "SpringBoard and mobiletimerd retry it in a tight loop without it, about 4 cores",
    "com.apple.gamed": "every app launch by an XCUITest waits about 10.5 s without it",
}

CORE_FAMILIES = {
    "wallpaper posters": ["com.apple.PosterBoard"],
    "widgets and live activities": ["com.apple.chronod", "com.apple.liveactivitiesd", "com.apple.MapKit.SnapshotService",
                                    "com.apple.replicatord"],
    "Siri and intelligence": ["com.apple.sirittsd", "com.apple.assistantd", "com.apple.siriactionsd",
                              "com.apple.siriinferenced", "com.apple.siri.context.service", "com.apple.siriknowledged",
                              "com.apple.assistant_cdmd", "com.apple.corespeechd", "com.apple.voicebankingd",
                              "com.apple.intelligenceflowd", "com.apple.intelligencecontextd",
                              "com.apple.generativeexperiencesd", "com.apple.modelcatalogd", "com.apple.modelmanagerd"],
    "search and suggestions": ["com.apple.spotlightknowledged.updater", "com.apple.searchd", "com.apple.hybridsearchd",
                               "com.apple.fileindexerd", "com.apple.suggestd", "com.apple.parsecd", "com.apple.peopled"],
    "device management": ["com.apple.remotemanagementd", "com.apple.DeviceConfigurationAgent"],
    "health, home and fitness": ["com.apple.homed", "com.apple.homeeventsd", "com.apple.healthd", "com.apple.fitcore",
                                 "com.apple.fitnesscoachingd", "com.apple.fitnessintelligenced", "com.apple.sleepd",
                                 "com.apple.activitysharingd", "com.apple.activityawardsd"],
    "watch and companion": ["com.apple.nanotimekitcompaniond", "com.apple.companionappd", "com.apple.nanoregistrylaunchd", "com.apple.nanoprefsyncd.2", "com.apple.NPKCompanionAgent",
                            "com.apple.brook.brookcompaniond", "com.apple.appconduitd", "com.apple.wcd"],
}


def running_labels(run_dir):
    labels = []
    for line in open(f"{run_dir}/launchctl-list.txt"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) == 3 and parts[0].isdigit():
            labels.append(parts[2])
    return labels


def disableable(label):
    return label.startswith("com.apple.") and ".oneshot." not in label


def core(run_dir):
    seen = set(running_labels(run_dir))
    return [label for family in CORE_FAMILIES.values() for label in family if label in seen and label not in KEEP]


def full(run_dir):
    return sorted(label for label in set(running_labels(run_dir)) if disableable(label) and label not in KEEP)


def main():
    which, run_dir = sys.argv[1], sys.argv[2]
    for label in (core if which == "core" else full)(run_dir):
        print(label)


if __name__ == "__main__":
    main()
