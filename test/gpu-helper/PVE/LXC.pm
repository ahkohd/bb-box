package PVE::LXC;
use strict;
use warnings;
use PVE::FakeConfig;

sub running_dir { return PVE::FakeConfig::root() . '/run/fake-pve/running' }

sub check_running {
    my ($vmid) = @_;
    return -e running_dir() . "/$vmid" ? 1 : undef;
}

sub list_active_containers {
    my %active;
    opendir(my $dh, running_dir()) or return \%active;
    $active{$_} = 1 for grep { /^\d+$/ } readdir $dh;
    closedir $dh;
    return \%active;
}

1;
