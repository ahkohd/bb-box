
const building = new Map<string, Set<string>>();

function key(hostId: string, image: string): string {
  return `${hostId}\0${image}`;
}

export function noteDockerImageBuild(hostId: string, images: readonly string[], on: boolean): void {
  for (const image of images) {
    const id = key(hostId, image);
    if (!on) {
      building.delete(id);
      continue;
    }
    const noted = building.get(id) ?? new Set<string>();
    noted.add(image);
    building.set(id, noted);
  }
}

export function dockerImageBuilding(hostId: string | null, image: string): boolean {
  return !!hostId && building.has(key(hostId, image));
}
