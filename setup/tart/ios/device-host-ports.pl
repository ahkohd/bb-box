use strict;
use warnings;
use IO::Select;
use IO::Socket::IP;
use Socket qw(SOMAXCONN);

my $words = "This port is shared by every box on this iOS host. Use your box's ports, from BB_PORT_BASE.\n";
my $answer = join "\r\n",
  "HTTP/1.1 421 Misdirected Request",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Length: " . length($words),
  "Connection: close",
  "", $words;
my $request_wait_s = 1;
my $request_most_bytes = 65536;

die "usage: device-host-ports <port>...\n" unless @ARGV;
my @listeners;
for my $port (@ARGV) {
  die "device-host-ports: $port is not a port\n" unless $port =~ /^\d+$/ && $port > 0 && $port < 65536;
  for my $address ("127.0.0.1", "::1") {
    my $listener = IO::Socket::IP->new(LocalHost => $address, LocalPort => $port, Listen => SOMAXCONN, Proto => "tcp", ReuseAddr => 0, V6Only => 1);
    if ($listener) {
      $listener->blocking(0);
      push @listeners, $listener;
      print STDERR "device-host-ports: holding $address:$port\n";
    } else {
      print STDERR "device-host-ports: could not hold $address:$port: $@\n";
    }
  }
}
die "device-host-ports: held no port\n" unless @listeners;

$SIG{PIPE} = "IGNORE";
my $waiting = IO::Select->new(@listeners);
while (1) {
  for my $listener ($waiting->can_read) {
    my $client = $listener->accept or next;
    my $read = IO::Select->new($client);
    my $request = "";
    while (length($request) < $request_most_bytes && $request !~ /\r?\n\r?\n/ && $read->can_read($request_wait_s)) {
      my $got = sysread($client, my $chunk, 4096);
      last unless $got;
      $request .= $chunk;
    }
    syswrite($client, $answer);
    shutdown($client, 1);
    close($client);
  }
}
