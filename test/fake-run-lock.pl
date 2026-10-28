use Fcntl;
my ($config, $running, $parent) = @ARGV;
open(my $handle, "+<", $config) or die "open $config: $!";
my $lock = $^O eq "darwin" ? pack("q q l s s", 0, 0, 0, F_WRLCK, 0) : pack("s s x4 q q l x4", F_WRLCK, 0, 0, 0, 0);
fcntl($handle, F_SETLK, $lock) or die "lock $config: $!";
$| = 1;
print "locked\n";
select(undef, undef, undef, 0.02) while -e $running && kill(0, $parent);
