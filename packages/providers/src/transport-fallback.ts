import { isTransportFailure } from "./errors";
import { annotateProviderErrorHopUsed } from "./judge-diagnostics";
import {
  SemanticProviderCallContextV1Schema,
  SemanticProviderDescriptorV1Schema,
  SemanticProviderRawResponseV1Schema,
  type SemanticProviderCallContextV1,
  type SemanticProviderDescriptorV1,
  type SemanticProviderRawResponseV1,
  type SemanticProviderRepairInstructionV1,
} from "./learning-proof";
import type {
  InlineMultimodalJudgeDescriptorV1,
  InlineMultimodalJudgeProvider,
  MultimodalJudgeProviderInputV1,
  MultimodalJudgeProviderResultV1,
} from "./hetzner-multimodal";
import type { ProviderContextV1 } from "./contracts";

type RepairableSemanticProvider<TInput> = {
  readonly descriptor: SemanticProviderDescriptorV1;
  generate(
    input: TInput,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
  repair(
    input: TInput,
    instruction: SemanticProviderRepairInstructionV1,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1>;
};

export const SEMANTIC_TRANSPORT_FALLBACK_RESERVE_MS = 120_000;
export const SEMANTIC_TRANSPORT_FALLBACK_MIN_PRIMARY_MS = 30_000;

export type TransportFallbackSemanticOptions = {
  now?: () => number;
  reserveMs?: number;
};

/**
 * Leaves a hop window inside the shared generation deadline. A primary hang
 * that consumes the whole run budget would otherwise throw DEADLINE_EXCEEDED
 * with ~0 ms remaining, so Qwen is never actually invoked.
 */
export function reserveTransportFallbackDeadline(
  deadlineAt: Date,
  nowMs: number,
  reserveMs = SEMANTIC_TRANSPORT_FALLBACK_RESERVE_MS,
  minPrimaryMs = SEMANTIC_TRANSPORT_FALLBACK_MIN_PRIMARY_MS,
): Date {
  const remaining = deadlineAt.getTime() - nowMs;
  if (
    !Number.isFinite(remaining) ||
    remaining <= minPrimaryMs ||
    reserveMs <= 0
  ) {
    return deadlineAt;
  }
  const reserved = Math.min(reserveMs, remaining - minPrimaryMs);
  return reserved <= 0 ? deadlineAt : new Date(deadlineAt.getTime() - reserved);
}

export class TransportFallbackSemanticProvider<
  TInput,
> implements RepairableSemanticProvider<TInput> {
  readonly descriptor: SemanticProviderDescriptorV1;
  private readonly now: () => number;
  private readonly reserveMs: number;

  constructor(
    private readonly primary: RepairableSemanticProvider<TInput>,
    private readonly fallback: RepairableSemanticProvider<TInput>,
    options: TransportFallbackSemanticOptions = {},
  ) {
    this.descriptor = primary.descriptor;
    this.now = options.now ?? Date.now;
    this.reserveMs =
      options.reserveMs ?? SEMANTIC_TRANSPORT_FALLBACK_RESERVE_MS;
  }

  generate(
    input: TInput,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    return this.invoke(
      (callContext) => this.primary.generate(input, callContext),
      (callContext) => this.fallback.generate(input, callContext),
      context,
      this.primary.descriptor,
      this.fallback.descriptor,
    );
  }

  repair(
    input: TInput,
    instruction: SemanticProviderRepairInstructionV1,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    return this.invoke(
      (callContext) => this.primary.repair(input, instruction, callContext),
      (callContext) => this.fallback.repair(input, instruction, callContext),
      context,
      this.primary.descriptor,
      this.fallback.descriptor,
    );
  }

  private async invoke(
    primaryCall: (
      context: SemanticProviderCallContextV1,
    ) => Promise<SemanticProviderRawResponseV1>,
    fallbackCall: (
      context: SemanticProviderCallContextV1,
    ) => Promise<SemanticProviderRawResponseV1>,
    context: SemanticProviderCallContextV1,
    primaryDescriptor: SemanticProviderDescriptorV1,
    fallbackDescriptor: SemanticProviderDescriptorV1,
  ): Promise<SemanticProviderRawResponseV1> {
    const primaryContext = SemanticProviderCallContextV1Schema.parse({
      ...context,
      deadlineAt: reserveTransportFallbackDeadline(
        context.deadlineAt,
        this.now(),
        this.reserveMs,
      ),
    });
    try {
      return attachAnsweredBy(
        await primaryCall(primaryContext),
        primaryDescriptor,
      );
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      return attachAnsweredBy(await fallbackCall(context), fallbackDescriptor);
    }
  }
}

export class TransportFallbackMultimodalJudgeProvider implements InlineMultimodalJudgeProvider {
  readonly descriptor: InlineMultimodalJudgeDescriptorV1;
  readonly transportFallbackDescriptor: InlineMultimodalJudgeDescriptorV1;

  constructor(
    private readonly primary: InlineMultimodalJudgeProvider,
    private readonly fallback: InlineMultimodalJudgeProvider,
  ) {
    this.descriptor = primary.descriptor;
    this.transportFallbackDescriptor = fallback.descriptor;
  }

  async evaluate(
    input: MultimodalJudgeProviderInputV1,
    context: ProviderContextV1,
  ): Promise<MultimodalJudgeProviderResultV1> {
    try {
      return await this.primary.evaluate(input, context);
    } catch (error) {
      if (!isTransportFailure(error)) {
        throw annotateProviderErrorHopUsed(error, "primary");
      }
      try {
        return await this.fallback.evaluate(input, context);
      } catch (fallbackError) {
        throw annotateProviderErrorHopUsed(fallbackError, "transport_fallback");
      }
    }
  }
}

function attachAnsweredBy(
  response: SemanticProviderRawResponseV1,
  descriptor: SemanticProviderDescriptorV1,
): SemanticProviderRawResponseV1 {
  return SemanticProviderRawResponseV1Schema.parse({
    ...response,
    answeredBy: SemanticProviderDescriptorV1Schema.parse(
      response.answeredBy ?? descriptor,
    ),
  });
}
