package PVE::INotify;
use strict;
use warnings;
use PVE::FakeConfig;

sub nodename { return PVE::FakeConfig::node() }

1;
