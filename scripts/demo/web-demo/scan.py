import argparse
import difflib
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

DICTIONARY = "/usr/share/dict/words"
WORD = re.compile(r"[a-z][a-z0-9]*", re.IGNORECASE)
ALPHANUMERIC = re.compile(r"[a-z0-9]+", re.IGNORECASE)
SUBSTRING_FROM_LENGTH = 5
PATTERN_PREFIX = "re:"
LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789"
FUZZY_DENY_FROM_LENGTH = 6
MIN_NEAR_LENGTH = 5
MIN_SIMILAR_LENGTH = 8
SIMILAR_RATIO = 0.8
COMPOUND = re.compile(r"[a-z0-9]+(?:[-_.@:/][a-z0-9]+)+", re.IGNORECASE)
NEGATIVE_FILTER = "format=gray,negate,eq=contrast=2"
EXACT = 100.0


def parse_arguments():
    parser = argparse.ArgumentParser(description="Read every frame's text, and the page's own text, and fail on a denied name or a word not on the allow list.")
    parser.add_argument("takes", nargs="+", help="take directories record.mjs wrote, or directories of frames")
    parser.add_argument("--allow", action="append", default=[], help="file of allowed words, one per line, or re:<pattern> for a whole word; give it more than once to add files")
    parser.add_argument("--deny", action="append", default=[], help="file of names that must never show, one per line; keep it out of the repository")
    parser.add_argument("--min-frames", type=int, default=3, help="a word read from frames fails the scan once it shows in this many frames")
    parser.add_argument("--min-length", type=int, default=4, help="shorter words are not checked against the allow list")
    parser.add_argument("--min-confidence", type=float, default=60, help="words read with less confidence are checked only against the deny list")
    parser.add_argument("--jobs", type=int, default=os.cpu_count())
    return parser.parse_args()


def read_list(paths):
    entries = []
    for path in paths:
        with open(path) as handle:
            entries += [line.strip() for line in handle if line.strip() and not line.startswith("#")]
    return entries


class AllowList:
    def __init__(self, entries):
        self.words = set()
        if os.path.exists(DICTIONARY):
            with open(DICTIONARY, errors="ignore") as handle:
                self.words |= {line.strip().removesuffix("'s") for line in handle if line[:1].islower()}
        else:
            print(f"No {DICTIONARY}; every word must be on the allow list. Install wamerican.", file=sys.stderr)
        self.patterns = [re.compile(entry[len(PATTERN_PREFIX):], re.IGNORECASE) for entry in entries if entry.startswith(PATTERN_PREFIX)]
        for entry in entries:
            if not entry.startswith(PATTERN_PREFIX):
                self.words |= {part.lower() for part in WORD.findall(entry)}

    def allows(self, word):
        return word in self.words or any(pattern.fullmatch(word) for pattern in self.patterns)


def one_edit_away(word):
    splits = [(word[:index], word[index:]) for index in range(len(word) + 1)]
    deletes = [left + right[1:] for left, right in splits if right]
    swaps = [left + right[1] + right[0] + right[2:] for left, right in splits if len(right) > 1]
    replaces = [left + letter + right[1:] for left, right in splits if right for letter in LETTERS]
    inserts = [left + letter + right for left, right in splits for letter in LETTERS]
    return set(deletes + swaps + replaces + inserts)


class FrameReading:
    def __init__(self, allow, page_samples):
        texts = {" ".join(word for word, _ in words).lower() for _, words in page_samples}
        self.allow = allow
        self.page_words = {token for text in texts for token in WORD.findall(text)}
        self.page_run_together = "\n".join("".join(ALPHANUMERIC.findall(text)) for text in texts)
        self.page_compounds = {"".join(ALPHANUMERIC.findall(compound)) for text in texts for compound in COMPOUND.findall(text)}
        self.explained = {}

    def explains(self, word):
        if word not in self.explained:
            self.explained[word] = (
                word in self.page_words
                or (len(word) >= MIN_NEAR_LENGTH and word in self.page_run_together)
                or any(self.allow.allows(near) or near in self.page_words for near in one_edit_away(word))
                or any(near in self.page_run_together for near in one_edit_away(word) if len(near) >= MIN_NEAR_LENGTH)
                or self.resembles_a_page_compound(word)
            )
        return self.explained[word]

    def resembles_a_page_compound(self, word):
        if len(word) < MIN_SIMILAR_LENGTH:
            return False
        return any(
            abs(len(compound) - len(word)) <= 2 and difflib.SequenceMatcher(None, word, compound).ratio() >= SIMILAR_RATIO
            for compound in self.page_compounds
        )


def frames_in(directory):
    frames_dir = os.path.join(directory, "frames") if os.path.isdir(os.path.join(directory, "frames")) else directory
    names = sorted(name for name in os.listdir(frames_dir) if name.lower().endswith((".jpg", ".jpeg", ".png")))
    return frames_dir, names


def tesseract_words(image_path):
    result = subprocess.run(
        ["tesseract", image_path, "stdout", "--psm", "3", "tsv"],
        capture_output=True, text=True, env={**os.environ, "OMP_THREAD_LIMIT": "1"},
    )
    if result.returncode != 0:
        raise RuntimeError(f"tesseract failed on {image_path}: {result.stderr.strip()}")
    rows = [line.split("\t") for line in result.stdout.splitlines()[1:]]
    return [(row[11], float(row[10])) for row in rows if len(row) == 12 and row[11].strip()]


def negative_of(frame_path, scratch_dir):
    negative = os.path.join(scratch_dir, os.path.basename(frame_path) + ".png")
    subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", frame_path, "-vf", NEGATIVE_FILTER, negative], check=True)
    return negative


def read_frame(frame_path, cache_dir, scratch_dir):
    with open(frame_path, "rb") as handle:
        digest = hashlib.sha1(handle.read()).hexdigest()
    cached = os.path.join(cache_dir, f"{digest}.json")
    if os.path.exists(cached):
        with open(cached) as handle:
            return json.load(handle)
    negative = negative_of(frame_path, scratch_dir)
    words = tesseract_words(frame_path) + tesseract_words(negative)
    os.remove(negative)
    with open(cached, "w") as handle:
        json.dump(words, handle)
    return words


def read_take(directory, jobs):
    frames_dir, names = frames_in(directory)
    cache_dir = os.path.join(directory, "text")
    os.makedirs(cache_dir, exist_ok=True)
    with tempfile.TemporaryDirectory() as scratch_dir, ThreadPoolExecutor(max_workers=jobs) as pool:
        frames = list(pool.map(lambda name: read_frame(os.path.join(frames_dir, name), cache_dir, scratch_dir), names))
    page_text_path = os.path.join(directory, "page-text.json")
    page_samples = []
    if os.path.exists(page_text_path):
        with open(page_text_path) as handle:
            page_samples = [(f"page@{index}", [(word, EXACT) for word in sample["text"].split()]) for index, sample in enumerate(json.load(handle))]
    return list(zip(names, frames)), page_samples


def denied_in(words, denied, fuzzy):
    tokens = {token.lower() for word in words for token in WORD.findall(word)}
    joined = " ".join(words).lower()
    squeezed = re.sub(r"\s+", "", joined)
    hits = []
    for line, name in enumerate(denied, start=1):
        wanted = name.lower()
        if len(wanted) < SUBSTRING_FROM_LENGTH:
            found = wanted in tokens
        else:
            found = wanted in joined or re.sub(r"\s+", "", wanted) in squeezed
        if not found and fuzzy and len(wanted) >= FUZZY_DENY_FROM_LENGTH and wanted.isalnum():
            found = bool(one_edit_away(wanted) & tokens)
        if found:
            hits.append(line)
    return hits


def unknown_words(words, allow, arguments):
    confident = " ".join(word for word, confidence in words if confidence >= arguments.min_confidence)
    return {word for word in (token.lower() for token in WORD.findall(confident)) if len(word) >= arguments.min_length and not allow.allows(word)}


def partly_typed(seen_on_page, page_samples):
    page_words = {token.lower() for _, words in page_samples for word, _ in words for token in WORD.findall(word)}
    return [word for word in seen_on_page if any(longer != word and longer.startswith(word) for longer in page_words)]


def scan(directory, allow, denied, arguments):
    frames, page_samples = read_take(directory, arguments.jobs)
    denied_hits = defaultdict(list)
    seen_in_frames = defaultdict(list)
    seen_on_page = defaultdict(list)
    reading = FrameReading(allow, page_samples)
    for source, words in page_samples:
        for hit in denied_in([word for word, _ in words], denied, fuzzy=False):
            denied_hits[hit].append(source)
        for word in unknown_words(words, allow, arguments):
            seen_on_page[word].append(source)
    for source, words in frames:
        for hit in denied_in([word for word, _ in words], denied, fuzzy=True):
            denied_hits[hit].append(source)
        for word in unknown_words(words, allow, arguments):
            if not reading.explains(word):
                seen_in_frames[word].append(source)
    for word in partly_typed(seen_on_page, page_samples):
        del seen_on_page[word]
    flagged = {word for word, sources in seen_in_frames.items() if len(sources) >= arguments.min_frames} | set(seen_on_page)
    everything = sorted(set(seen_in_frames) | set(seen_on_page), key=lambda word: -(len(seen_in_frames[word]) + len(seen_on_page[word])))
    with open(os.path.join(directory, "words.tsv"), "w") as handle:
        handle.write("word\tframes\tpage samples\tfirst\tflagged\n")
        for word in everything:
            first = (seen_on_page[word] or seen_in_frames[word])[0]
            handle.write(f"{word}\t{len(seen_in_frames[word])}\t{len(seen_on_page[word])}\t{first}\t{'yes' if word in flagged else 'no'}\n")
    print(f"{directory}: {len(frames)} frames and {len(page_samples)} page samples read, {len(denied_hits)} denied names, {len(flagged)} unknown words")
    for hit, sources in denied_hits.items():
        print(f"  DENIED: the deny list's entry {hit} in {len(sources)} frames or samples, first {sources[0]}")
    for word in everything:
        if word in flagged:
            print(f"  unknown {word!r}: {len(seen_in_frames[word])} frames, {len(seen_on_page[word])} page samples")
    return bool(denied_hits) or bool(flagged)


def main():
    arguments = parse_arguments()
    allow = AllowList(read_list(arguments.allow))
    denied = read_list(arguments.deny)
    failed = [directory for directory in arguments.takes if scan(directory, allow, denied, arguments)]
    sys.exit(1 if failed else 0)


main()
