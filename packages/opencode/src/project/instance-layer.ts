import { Effect, Layer } from "effect"
import { InstanceStore } from "./instance-store"

export const layer: Layer.Layer<InstanceStore.Service> = Layer.unwrap(
  Effect.promise(async () => {
    const { InstanceBootstrap } = await import("./bootstrap")
    return InstanceStore.defaultLayer.pipe(Layer.provide(InstanceBootstrap.defaultLayer))
  }).pipe(Effect.orDie),
)

export * as InstanceLayer from "./instance-layer"
