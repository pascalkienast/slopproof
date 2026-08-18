import { isTransportFailure } from "./errors";
import {
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

export class TransportFallbackSemanticProvider<
  TInput,
> implements RepairableSemanticProvider<TInput> {
  readonly descriptor: SemanticProviderDescriptorV1;

  constructor(
    private readonly primary: RepairableSemanticProvider<TInput>,
    private readonly fallback: RepairableSemanticProvider<TInput>,
  ) {
    this.descriptor = primary.descriptor;
  }

  generate(
    input: TInput,
    context: SemanticProviderCallContextV1,
  ): Promise<SemanticProviderRawResponseV1> {
    return this.invoke(
      () => this.primary.generate(input, context),
      () => this.fallback.generate(input, context),
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
      () => this.primary.repair(input, instruction, context),
      () => this.fallback.repair(input, instruction, context),
      this.primary.descriptor,
      this.fallback.descriptor,
    );
  }

  private async invoke(
    primaryCall: () => Promise<SemanticProviderRawResponseV1>,
    fallbackCall: () => Promise<SemanticProviderRawResponseV1>,
    primaryDescriptor: SemanticProviderDescriptorV1,
    fallbackDescriptor: SemanticProviderDescriptorV1,
  ): Promise<SemanticProviderRawResponseV1> {
    try {
      return attachAnsweredBy(await primaryCall(), primaryDescriptor);
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      return attachAnsweredBy(await fallbackCall(), fallbackDescriptor);
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
      if (!isTransportFailure(error)) throw error;
      return await this.fallback.evaluate(input, context);
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
