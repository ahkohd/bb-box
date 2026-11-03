package PVE::LXC::Config;
use strict;
use warnings;
use PVE::FakeConfig;

sub lock_config_full {
    my ($class, $vmid, $timeout, $code, @param) = @_;
    return PVE::FakeConfig::lock_full('lxc', $vmid, $timeout, $code, @param);
}

sub lock_config {
    my ($class, $vmid, $code, @param) = @_;
    return PVE::FakeConfig::lock_full('lxc', $vmid, 10, $code, @param);
}

sub load_config {
    my ($class, $vmid) = @_;
    return PVE::FakeConfig::load('lxc', $vmid);
}

sub check_protection {
    my ($class, $conf, $error) = @_;
    die "$error - protection mode enabled\n" if ($conf->{protection} // '') eq '1';
}

sub check_lock {
    my ($class, $conf) = @_;
    die "CT is locked ($conf->{lock})\n" if $conf->{lock};
}

sub destroy_config {
    my ($class, $vmid) = @_;
    PVE::FakeConfig::require_held('lxc', $vmid, 'destroy_config');
    unlink PVE::FakeConfig::config_path('lxc', $vmid) or die "fake pve: cannot remove $vmid: $!\n";
    PVE::FakeConfig::log_line('power.log', "removed $vmid");
}

sub write_config {
    my ($class, $vmid, $conf) = @_;
    return PVE::FakeConfig::write('lxc', $vmid, $conf);
}

1;
