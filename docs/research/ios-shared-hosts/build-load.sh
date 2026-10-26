#!/bin/sh
set -eu

case ${1:-} in
  make)
    root=${2:?folder}
    files=${3:-300}
    rm -rf "$root"
    mkdir -p "$root/Sources/Load"
    cat >"$root/Package.swift" <<'EOF'
// swift-tools-version:6.0
import PackageDescription
let package = Package(name: "Load", platforms: [.iOS(.v18)], products: [.library(name: "Load", targets: ["Load"])], targets: [.target(name: "Load")])
EOF
    index=1
    while [ "$index" -le "$files" ]; do
      cat >"$root/Sources/Load/File$index.swift" <<EOF
import Foundation

public struct Record$index: Codable, Hashable, Sendable {
  public var id: Int
  public var name: String
  public var values: [Double]
  public var tags: Set<String>
  public var nested: [String: [Int]]
}

public protocol Shape$index { associatedtype Value: Numeric; func area() -> Value }

public struct Box$index<T: Numeric & Comparable>: Shape$index {
  public var sides: [T]
  public func area() -> T { sides.reduce(1, *) }
  public func largest() -> T? { sides.max() }
}

public enum Event$index: Codable, Equatable { case started(Int), stopped(String, Double), moved(x: Double, y: Double), nothing }

public func work$index(_ records: [Record$index]) -> [String: Double] {
  let grouped: [String: [Record$index]] = Dictionary(grouping: records) { (record: Record$index) -> String in record.tags.sorted().first ?? "none" }
  var result: [String: Double] = [:]
  for (key, group) in grouped {
    var total: Double = 0
    for record in group {
      let scaled: [Double] = record.values.map { (value: Double) -> Double in value * 2.5 + Double(record.id) }
      total += scaled.filter { (value: Double) -> Bool in value > 1 }.reduce(0, +)
    }
    result[key] = total / Double(max(group.count, 1))
  }
  return result
}

public func encode$index(_ records: [Record$index]) throws -> Data {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
  return try encoder.encode(records.sorted { (\$0.id, \$0.name) < (\$1.id, \$1.name) })
}
EOF
      index=$((index + 1))
    done
    ;;
  build)
    root=${2:?folder}
    derived=${3:?derived data folder}
    rm -rf "$derived"
    started=$(python3 -c 'import time; print(time.time())')
    (cd "$root" && xcodebuild -scheme Load -destination 'generic/platform=iOS Simulator' -derivedDataPath "$derived" ARCHS=arm64 ONLY_ACTIVE_ARCH=YES build -quiet >"$derived.log" 2>&1) && result=ok || result=failed
    echo "build $result $(python3 -c "import sys, time; print(f'{time.time() - float(sys.argv[1]):.1f}')" "$started") s"
    ;;
  *) echo "usage: build-load.sh make <folder> [files] | build <folder> <derived data>" >&2; exit 2 ;;
esac
