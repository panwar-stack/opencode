#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@opencode-ai/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]
const uvVersion = "0.11.17"

const uvTargets = [
  { name: "opencode-uv-darwin-arm64", os: "darwin", cpu: "arm64", artifact: "uv-aarch64-apple-darwin.tar.gz" },
  { name: "opencode-uv-darwin-x64", os: "darwin", cpu: "x64", artifact: "uv-x86_64-apple-darwin.tar.gz" },
  { name: "opencode-uv-linux-arm64", os: "linux", cpu: "arm64", artifact: "uv-aarch64-unknown-linux-gnu.tar.gz" },
  { name: "opencode-uv-linux-x64", os: "linux", cpu: "x64", artifact: "uv-x86_64-unknown-linux-gnu.tar.gz" },
  {
    name: "opencode-uv-linux-arm64-musl",
    os: "linux",
    cpu: "arm64",
    artifact: "uv-aarch64-unknown-linux-musl.tar.gz",
  },
  {
    name: "opencode-uv-linux-x64-musl",
    os: "linux",
    cpu: "x64",
    artifact: "uv-x86_64-unknown-linux-musl.tar.gz",
  },
  { name: "opencode-uv-windows-arm64", os: "win32", cpu: "arm64", artifact: "uv-aarch64-pc-windows-msvc.zip" },
  { name: "opencode-uv-windows-x64", os: "win32", cpu: "x64", artifact: "uv-x86_64-pc-windows-msvc.zip" },
] as const
const uvBinaries = Object.fromEntries(uvTargets.map((target) => [target.name, version]))

async function prepareUvPackage(target: (typeof uvTargets)[number]) {
  const out = `./dist/${target.name}`
  const temp = `./dist/${target.name}-download`
  const archive = `${temp}/${target.artifact}`
  const url = `https://github.com/astral-sh/uv/releases/download/${uvVersion}/${target.artifact}`
  await $`rm -rf ${out} ${temp}`
  await $`mkdir -p ${out}/bin ${temp}`
  await $`curl -fsSL ${url} -o ${archive}`

  const expected = (await fetch(`${url}.sha256`).then((response) => response.text())).trim().split(/\s+/)[0]
  const actual = new Bun.CryptoHasher("sha256").update(await Bun.file(archive).arrayBuffer()).digest("hex")
  if (actual !== expected) throw new Error(`Checksum mismatch for ${target.artifact}`)

  if (target.artifact.endsWith(".zip")) await $`unzip -q ${archive} -d ${temp}`
  else await $`tar -xzf ${archive} -C ${temp}`

  const source = `${temp}/${target.artifact.replace(/\.(tar\.gz|zip)$/, "")}`
  const extension = target.os === "win32" ? ".exe" : ""
  await $`cp ${source}/uv${extension} ${out}/bin/uv${extension}`
  await $`cp ${source}/uvx${extension} ${out}/bin/uvx${extension}`
  if (target.os !== "win32") await $`chmod 755 ${out}/bin/uv ${out}/bin/uvx`
  await Bun.file(`${out}/package.json`).write(
    JSON.stringify(
      {
        name: target.name,
        version,
        preferUnplugged: true,
        os: [target.os],
        cpu: [target.cpu],
        uv: uvVersion,
      },
      null,
      2,
    ),
  )
}

await Promise.all(uvTargets.map(prepareUvPackage))

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}-ai's postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name}-ai && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name}-ai without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name + "-ai",
      bin: {
        [pkg.name]: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: { ...binaries, ...uvBinaries },
    },
    null,
    2,
  ),
)

const tasks = Object.entries({ ...binaries, ...uvBinaries }).map(async ([name, version]) => {
  await publish(`./dist/${name}`, name, version)
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, `${pkg.name}-ai`, version)

const image = "ghcr.io/anomalyco/opencode"
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
if (!Script.preview) {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/opencode-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/opencode-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/opencode-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/opencode-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    "pkgname='opencode-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/anomalyco/opencode'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('opencode')",
    "conflicts=('opencode')",
    "depends=('ripgrep' 'uv')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/anomalyco/opencode/releases/download/v\${pkgver}\${_subver}/opencode-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/anomalyco/opencode/releases/download/v\${pkgver}\${_subver}/opencode-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./opencode "${pkgdir}/usr/bin/opencode"',
    "}",
    "",
  ].join("\n")

  for (const [pkg, pkgbuild] of [["opencode-bin", binaryPkgbuild]]) {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-${pkg}`
        await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
        await $`cd ./dist/aur-${pkg} && git checkout master`
        await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
        await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
        await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-${pkg} && git push`
        break
      } catch {
        continue
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Opencode < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/anomalyco/opencode"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    `  depends_on "uv"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/anomalyco/opencode/releases/download/v${Script.version}/opencode-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "opencode"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error("GITHUB_TOKEN is required to update homebrew tap")
    process.exit(1)
  }
  const tap = `https://x-access-token:${token}@github.com/anomalyco/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/opencode.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add opencode.rb`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
