use strict;
use warnings;
use File::Path qw(make_path);
use Time::HiRes qw(sleep);
use PVE::LXC::Config;

my ($vmid, $seconds, $then) = @ARGV;
PVE::LXC::Config->lock_config($vmid, sub {
    print "locked\n";
    STDOUT->flush;
    sleep($seconds);
    if (($then // '') eq 'replace') {
        my $config = PVE::FakeConfig::config_path('lxc', $vmid);
        rename("$config.next", $config) or die "cannot replace CT $vmid: $!";
    }
    if (($then // '') eq 'start') {
        my $dir = PVE::FakeConfig::root() . '/run/fake-pve/running';
        make_path($dir);
        open(my $fh, '>', "$dir/$vmid") or die;
        close $fh;
    }
});
