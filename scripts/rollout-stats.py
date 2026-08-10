#!/usr/bin/env python3
"""Statistics over consecutive tool-call sequences in Tenon agent rollouts."""
import json, glob, os, collections

DIRS = [
    os.path.expanduser("~/Library/Application Support/Tenon/agent/rollouts"),
    os.path.expanduser("~/.lin-outliner-cc/agent/rollouts"),
    os.path.expanduser("~/.lin-outliner-cc-2/agent/rollouts"),
    os.path.expanduser("~/.lin-outliner-codex-3/agent/rollouts"),
]

TOOL_ITEM_KINDS = {"dynamicToolCall", "commandExecution", "webSearch", "collabAgentToolCall"}

def tool_label(item):
    t = item.get("type")
    if t == "dynamicToolCall":
        ns = item.get("namespace")
        return (ns + "." if ns else "") + (item.get("tool") or "?")
    if t == "commandExecution":
        return "bash"
    if t == "webSearch":
        return "web_search"
    if t == "collabAgentToolCall":
        for k in ("tool", "toolName", "action", "kind"):
            if item.get(k):
                return "collab." + str(item[k])
        return "collab.?"
    return t

turns = collections.defaultdict(list)  # (file, turnId) -> [tool labels in order]
turn_order = []
collab_samples = []
node_mentions = []

for d in DIRS:
    for fp in sorted(glob.glob(d + "/*.jsonl")):
        with open(fp) as f:
            for line in f:
                try:
                    e = json.loads(line).get("event", {})
                except Exception:
                    continue
                if e.get("type") != "item/started":
                    continue
                item = e.get("item", {})
                if item.get("type") not in TOOL_ITEM_KINDS:
                    continue
                key = (os.path.basename(fp), e.get("turnId"))
                if key not in turns:
                    turn_order.append(key)
                turns[key].append(tool_label(item))
                if item.get("type") == "collabAgentToolCall" and len(collab_samples) < 3:
                    collab_samples.append(json.dumps(item)[:300])

# --- stats ---
total_calls = sum(len(v) for v in turns.values())
tool_freq = collections.Counter(t for seq in turns.values() for t in seq)
run_lengths = collections.defaultdict(collections.Counter)  # tool -> run length counter
bigrams = collections.Counter()
turn_lengths = collections.Counter()

for seq in turns.values():
    turn_lengths[len(seq)] += 1
    i = 0
    while i < len(seq):
        j = i
        while j < len(seq) and seq[j] == seq[i]:
            j += 1
        run_lengths[seq[i]][j - i] += 1
        i = j
    for a, b in zip(seq, seq[1:]):
        if a != b:
            bigrams[(a, b)] += 1

print(f"turns with tool calls: {len(turns)}   total tool calls: {total_calls}")
print(f"\ntool frequency:")
for k, v in tool_freq.most_common():
    print(f"  {v:5d}  {k}")

print(f"\nturn-length distribution (tool calls per turn):")
for k in sorted(turn_lengths):
    print(f"  {k:3d} calls/turn: {turn_lengths[k]} turns")

print(f"\nconsecutive same-tool runs (length>=2 is a potential batch):")
for tool, c in sorted(run_lengths.items(), key=lambda kv: -sum(kv[1].values())):
    runs2 = {L: n for L, n in c.items() if L >= 2}
    total_runs = sum(c.values())
    if runs2:
        detail = ", ".join(f"len{L}x{n}" for L, n in sorted(runs2.items()))
        calls_in_runs = sum(L * n for L, n in runs2.items())
        print(f"  {tool}: {total_runs} runs, batchable runs: {detail}  ({calls_in_runs} calls in runs>=2)")
    else:
        print(f"  {tool}: {total_runs} runs, all singletons")

print(f"\ntop cross-tool bigrams:")
for (a, b), v in bigrams.most_common(12):
    print(f"  {v:4d}  {a} -> {b}")

print("\ncollab item samples:")
for s in collab_samples:
    print("  " + s)

# longest single-tool runs with context
print("\nlongest runs (tool, length, file, turn):")
longest = []
for (fp, turn), seq in turns.items():
    i = 0
    while i < len(seq):
        j = i
        while j < len(seq) and seq[j] == seq[i]:
            j += 1
        if j - i >= 3:
            longest.append((j - i, seq[i], fp, turn))
        i = j
for L, tool, fp, turn in sorted(longest, reverse=True)[:10]:
    print(f"  {L:3d}x {tool}  {fp}")
