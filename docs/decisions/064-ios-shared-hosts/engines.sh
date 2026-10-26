#!/bin/sh
cd ~/exp
for i in 1 2 3 4 5 6; do
  python3 enc.py --n 4 --seconds 12 --label "together-$i" 2>/dev/null
  python3 enc.py --n 4 --seconds 10 --stagger 1.5 --label "staggered-$i" 2>/dev/null
done
