export type CpuList = readonly number[];

export interface PinnedBox {
  readonly id: string;
  readonly cpus: CpuList;
}

export function parseCpuList(text: string | null | undefined): number[] | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const cpus = new Set<number>();
  for (const part of trimmed.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!range) return null;
    const first = Number(range[1]);
    const last = range[2] === undefined ? first : Number(range[2]);
    if (last < first) return null;
    for (let cpu = first; cpu <= last; cpu++) cpus.add(cpu);
  }
  return [...cpus].sort((a, b) => a - b);
}

export function formatCpuList(cpus: CpuList): string {
  const sorted = [...new Set(cpus)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    runs.push(i === j ? String(sorted[i]) : `${sorted[i]}-${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(",");
}

export function daemonCpusFromRefusal(message: string): number[] | null {
  const available = /available: ([\d,-]+)/.exec(message);
  return available ? parseCpuList(available[1]) : null;
}

export function cpusBothAllow(probed: CpuList, daemon: CpuList | null): number[] {
  if (!daemon) return [...probed];
  const both = probed.filter((cpu) => daemon.includes(cpu));
  return both.length ? both : [...daemon];
}

export function cpusToPinTo(probed: CpuList, daemon: CpuList | null, cores: number): number[] | null {
  const both = cpusBothAllow(probed, daemon);
  return both.length < Math.min(Math.ceil(cores), probed.length) ? null : both;
}

export function hostCpusFromProbe(output: string | null, count: number): number[] {
  return parseCpuList(output) ?? hostCpuRange(count);
}

export function hostCpuRange(count: number): number[] {
  return Array.from({ length: Math.max(0, count) }, (_, cpu) => cpu);
}

function boxesPerCpu(host: CpuList, pinned: readonly CpuList[]): Map<number, number> {
  const used = new Map(host.map((cpu) => [cpu, 0]));
  for (const cpus of pinned) for (const cpu of cpus) if (used.has(cpu)) used.set(cpu, used.get(cpu)! + 1);
  return used;
}

function leastUsedFirst(used: ReadonlyMap<number, number>): number[] {
  return [...used.keys()].sort((a, b) => used.get(a)! - used.get(b)! || a - b);
}

export function allotCpus(host: CpuList, pinned: readonly CpuList[], cores: number): number[] {
  const count = Math.min(Math.ceil(cores), host.length);
  return leastUsedFirst(boxesPerCpu(host, pinned)).slice(0, count).sort((a, b) => a - b);
}

export function resizeCpus(host: CpuList, others: readonly CpuList[], mine: CpuList, cores: number): number[] {
  const count = Math.min(Math.ceil(cores), host.length);
  const kept = mine.filter((cpu) => host.includes(cpu));
  const used = boxesPerCpu(host, others);
  if (kept.length >= count) {
    const mostSharedLast = [...kept].sort((a, b) => used.get(a)! - used.get(b)! || a - b);
    return mostSharedLast.slice(0, count).sort((a, b) => a - b);
  }
  const added = leastUsedFirst(used).filter((cpu) => !kept.includes(cpu)).slice(0, count - kept.length);
  return [...kept, ...added].sort((a, b) => a - b);
}

export function movesOntoFreeCpus(host: CpuList, boxes: readonly PinnedBox[], held: readonly CpuList[] = []): PinnedBox[] {
  const used = boxesPerCpu(host, [...boxes.map((box) => box.cpus), ...held]);
  const free = () => [...used.keys()].filter((cpu) => used.get(cpu) === 0);
  const moves: PinnedBox[] = [];
  for (const box of [...boxes].sort((a, b) => a.id.localeCompare(b.id))) {
    let cpus = [...box.cpus];
    for (const cpu of box.cpus) {
      const offTheHost = !used.has(cpu);
      if (!offTheHost && used.get(cpu)! < 2) continue;
      const target = free()[0] ?? (offTheHost ? leastUsedFirst(used).find((other) => !cpus.includes(other)) : undefined);
      if (target === undefined) continue;
      if (!offTheHost) used.set(cpu, used.get(cpu)! - 1);
      used.set(target, used.get(target)! + 1);
      cpus = cpus.map((each) => (each === cpu ? target : each));
    }
    if (formatCpuList(cpus) !== formatCpuList(box.cpus)) moves.push({ id: box.id, cpus: cpus.sort((a, b) => a - b) });
  }
  return moves;
}
