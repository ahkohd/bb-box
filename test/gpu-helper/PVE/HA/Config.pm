package PVE::HA::Config;
use strict;
use warnings;

sub service_is_configured { return ($ENV{FAKE_PVE_HA} // '') eq $_[0] ? 1 : 0 }

1;
