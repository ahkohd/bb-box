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

sub write_config {
    my ($class, $vmid, $conf) = @_;
    return PVE::FakeConfig::write('lxc', $vmid, $conf);
}

1;
