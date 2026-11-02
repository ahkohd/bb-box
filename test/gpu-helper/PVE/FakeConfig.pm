package PVE::FakeConfig;
use strict;
use warnings;
use Fcntl qw(:flock);
use File::Basename qw(dirname);
use File::Path qw(make_path);
use POSIX ();
use Time::HiRes qw(time sleep);

my %held;

sub root { return $ENV{BBBOX_GPU_ROOT} // die "fake pve: BBBOX_GPU_ROOT is not set\n" }

sub node { return $ENV{FAKE_PVE_NODE} // 'pve' }

sub config_path {
    my ($kind, $vmid) = @_;
    return root() . '/etc/pve/nodes/' . node() . '/' . ($kind eq 'lxc' ? 'lxc' : 'qemu-server') . "/$vmid.conf";
}

sub lock_path {
    my ($kind, $vmid) = @_;
    return root() . ($kind eq 'lxc' ? "/var/lock/lxc/pve-config-$vmid.lock" : "/var/lock/qemu-server/lock-$vmid.conf");
}

sub decode_text {
    my ($text) = @_;
    $text =~ s/%([0-9a-fA-F]{2})/chr(hex($1))/ge;
    return $text;
}

sub encode_text {
    my ($text) = @_;
    $text =~ s/([^\x20-\x39\x3b-\x7e])/sprintf('%%%02X', ord($1))/ge;
    return $text;
}

sub parse {
    my ($text) = @_;
    my $conf = {};
    my $section = $conf;
    for my $line (split /\n/, $text) {
        next if $line =~ /^\s*$/;
        if ($line =~ /^\[([^\]]+)\]\s*$/) {
            $section = $1 eq 'pve:pending' ? ($conf->{pending} = {}) : ($conf->{snapshots}{$1} = {});
            next;
        }
        if ($line =~ /^#(.*)$/) {
            $section->{description} .= decode_text($1) . "\n";
            next;
        }
        if ($line =~ /^(lxc\.[^:\s]+):\s*(.*)$/) {
            push @{ $section->{lxc} }, [ $1, $2 ];
            next;
        }
        if ($line =~ /^([a-z][a-z0-9_-]*):\s*(.*)$/) {
            $section->{$1} = $2;
            next;
        }
        die "fake pve: cannot parse '$line'\n";
    }
    return $conf;
}

sub section_text {
    my ($section) = @_;
    my $raw = '';
    $raw .= '#' . encode_text($_) . "\n" for split /\n/, ($section->{description} // '');
    for my $key (sort keys %$section) {
        next if $key =~ /^(?:description|pending|snapshots|digest|lxc)$/;
        die "fake pve: newline in '$key'\n" if $section->{$key} =~ /\n/;
        $raw .= "$key: $section->{$key}\n";
    }
    $raw .= "$_->[0]: $_->[1]\n" for @{ $section->{lxc} // [] };
    return $raw;
}

sub text {
    my ($conf) = @_;
    my $raw = section_text($conf);
    $raw .= "\n[pve:pending]\n" . section_text($conf->{pending}) if $conf->{pending} && %{ $conf->{pending} };
    $raw .= "\n[$_]\n" . section_text($conf->{snapshots}{$_}) for sort keys %{ $conf->{snapshots} // {} };
    return $raw;
}

sub lock_full {
    my ($kind, $vmid, $timeout, $code, @param) = @_;
    my $path = lock_path($kind, $vmid);
    make_path(dirname($path));
    open(my $fh, '>>', $path) or die "fake pve: cannot open $path: $!\n";
    my $deadline = time + $timeout;
    until (flock($fh, LOCK_EX | LOCK_NB)) {
        die "can't lock file '$path' - got timeout\n" if time > $deadline;
        sleep(0.01);
    }
    log_line('locks.log', "$kind $vmid");
    swap_on_lock($kind, $vmid);
    print STDERR "fake-pve: locked $kind $vmid\n" if $ENV{FAKE_PVE_TRACE_LOCKS};
    local $held{"$kind $vmid"} = 1;
    my @result = eval { $code->(@param) };
    my $error = $@;
    print STDERR "fake-pve: unlocked $kind $vmid\n" if $ENV{FAKE_PVE_TRACE_LOCKS};
    close $fh;
    die $error if $error;
    return wantarray ? @result : $result[0];
}

sub swap_on_lock {
    my ($kind, $vmid) = @_;
    my ($who, $from) = split /=/, ($ENV{FAKE_PVE_SWAP_ON_LOCK} // ''), 2;
    return unless defined $from && $who eq "$kind $vmid";
    delete $ENV{FAKE_PVE_SWAP_ON_LOCK};
    open(my $in, '<', $from) or die "fake pve: cannot read $from: $!\n";
    local $/;
    my $text = <$in>;
    close $in;
    my $path = config_path($kind, $vmid);
    open(my $out, '>', $path) or die "fake pve: cannot write $path: $!\n";
    print {$out} $text;
    close $out;
    log_line('swaps.log', "$kind $vmid");
}

sub load {
    my ($kind, $vmid) = @_;
    my $path = config_path($kind, $vmid);
    open(my $fh, '<', $path) or die "Configuration file '$path' does not exist\n";
    local $/;
    my $text = <$fh>;
    close $fh;
    return parse($text);
}

sub log_line {
    my ($name, $line) = @_;
    my $log = root() . "/run/fake-pve/$name";
    make_path(dirname($log));
    open(my $lh, '>>', $log) or die "fake pve: cannot log to $log: $!\n";
    print {$lh} "$line\n";
    close $lh;
}

sub write {
    my ($kind, $vmid, $conf) = @_;
    die "fake pve: $kind $vmid written without its config lock\n" unless $held{"$kind $vmid"};
    die "fake pve: $kind $vmid refuses writes\n" if ($ENV{FAKE_PVE_REFUSE_WRITE} // '') eq "$kind $vmid";
    my $path = config_path($kind, $vmid);
    open(my $fh, '>', "$path.tmp") or die "fake pve: cannot write $path: $!\n";
    print {$fh} text($conf);
    close $fh;
    rename("$path.tmp", $path) or die "fake pve: cannot replace $path: $!\n";
    log_line('writes.log', "$kind $vmid");
    POSIX::_exit(137) if ($ENV{FAKE_PVE_DIE_AFTER_WRITE} // '') eq "$kind $vmid";
}

1;
