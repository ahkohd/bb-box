# The sudo forms bb-box uses, with the image's sudoers rule (customize-base.sh), on this Ubuntu: sudo on 24.04, sudo-rs on 26.04.
# Prints each result, for compare.sh.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq sudo >/dev/null 2>&1
echo "sudo: $(sudo --version 2>&1 | head -n 1)"
useradd -m -s /bin/bash box; useradd -m -s /bin/bash other
printf 'Defaults env_keep += "DEBIAN_FRONTEND"\n%s ALL=(ALL) NOPASSWD:ALL\n' box > /etc/sudoers.d/90-box; chmod 0440 /etc/sudoers.d/90-box
visudo -cf /etc/sudoers.d/90-box > /dev/null 2>&1; echo "visudo -cf: $?"
visudo -cqf /etc/sudoers.d/90-box > /dev/null 2>&1; echo "visudo -cqf: $?"
r() { local out; out=$(runuser -u box -- env DEBIAN_FRONTEND=noninteractive FOO=bar bash -c "$2" 2>&1); printf '%-22s exit %s: %s\n' "$1" "$?" "$(printf '%s' "$out" | tr '\n' '|' | head -c 90)"; }
r "sudo -n true" "sudo -n true"
r "sudo -n id -u" "sudo -n id -u"
r "sudo -n -u other" "sudo -n -u other id -un"
r "sudo -n -H -u other" "sudo -n -H -u other sh -c 'echo \$HOME'"
r "sudo -u other" "sudo -u other id -un"
r "sudo -iu other" "sudo -iu other sh -c 'echo \$HOME \$(pwd)'"
r "sudo -E keeps FOO" "sudo -E sh -c 'echo FOO=\$FOO'"
r "env_keep DEBIAN_FRONTEND" "sudo -n sh -c 'echo DF=\$DEBIAN_FRONTEND'"
r "sudo -l" "sudo -n -l | tail -n 2"
r "sudo -n env PATH" "sudo -n sh -c 'echo \$PATH'"
r "sudo -n -- cmd" "sudo -n -- id -un"
r "sudo VAR=v cmd" "sudo -n BAR=baz sh -c 'echo BAR=\$BAR'"
r "sudo bash -c with ;" "sudo -n bash -c 'echo a; echo b'"
r "sudo tee" "echo x | sudo -n tee /root/t > /dev/null; sudo -n cat /root/t"
