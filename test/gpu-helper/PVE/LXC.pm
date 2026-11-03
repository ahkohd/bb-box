package PVE::LXC;
use strict;
use warnings;
use PVE::FakeConfig;

sub running_dir { return PVE::FakeConfig::root() . '/run/fake-pve/running' }

sub check_running {
    my ($vmid) = @_;
    return -e running_dir() . "/$vmid" ? 1 : undef;
}

sub vm_start {
    my ($vmid, $conf, $skiplock) = @_;
    PVE::FakeConfig::require_held('lxc', $vmid, 'start');
    PVE::FakeConfig::log_line('power.log', "start $vmid");
    open(my $fh, '>', running_dir() . "/$vmid") or die "fake pve: cannot start $vmid: $!\n";
    close $fh;
}

sub vm_stop {
    my ($vmid, $kill, $shutdown_timeout, $kill_after_timeout) = @_;
    PVE::FakeConfig::require_held('lxc', $vmid, 'stop');
    die "fake pve: a shutdown of $vmid with no timeout, or that is not killed after it\n" if !$kill && !($shutdown_timeout && $kill_after_timeout);
    PVE::FakeConfig::log_line('power.log', ($kill ? 'stop' : 'shutdown') . " $vmid");
    unlink running_dir() . "/$vmid";
}

sub destroy_lxc_container {
    my ($storage_cfg, $vmid, $conf, $replacement_conf, $purge_unreferenced) = @_;
    PVE::FakeConfig::require_held('lxc', $vmid, 'destroy');
    die "fake pve: destroy of $vmid without its replacement lock\n" unless ($replacement_conf->{lock} // '') eq 'destroyed';
    PVE::FakeConfig::log_line('power.log', "destroy $vmid");
}

sub list_active_containers {
    my %active;
    opendir(my $dh, running_dir()) or return \%active;
    $active{$_} = 1 for grep { /^\d+$/ } readdir $dh;
    closedir $dh;
    return \%active;
}

1;
