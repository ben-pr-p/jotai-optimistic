import { Atom, WritableAtom, atom, useAtomValue, useSetAtom } from "jotai";

import {
  Draft,
  Objectish,
  Patch,
  applyPatches,
  castImmutable,
  enablePatches,
  produceWithPatches,
} from "immer";
import { useEffect } from "react";

enablePatches();

export const useSetInitialAtomValueFromQuery = <AtomValue>(
  atom: WritableAtom<AtomValue, [AtomValue], unknown>,
  queryData: AtomValue | undefined,
  isLoading: boolean
) => {
  const setAtomValue = useSetAtom(atom);
  useEffect(() => {
    if (!isLoading && queryData) {
      setAtomValue(queryData);
    }
  }, [setAtomValue, queryData, isLoading]);
};

type ImmerifiedAtom<Value> = WritableAtom<
  Value,
  [(draft: Draft<Value>) => void],
  void
>;

type ImmerUpdateFn<Value> = (
  draft: Draft<Value>
) => void | Promise<void | undefined>;

export const createDerivedImmerAtom = <AtomValue, DerivedValue>(
  rootAtom: ImmerifiedAtom<AtomValue>,
  getDerivedValue: (value: AtomValue) => DerivedValue
) => {
  const result = atom(
    (get) => {
      return castImmutable(getDerivedValue(get(rootAtom)));
    },
    (_get, set, update: ImmerUpdateFn<DerivedValue>) => {
      set(rootAtom, (draft) => {
        const subObject = getDerivedValue(draft as AtomValue);
        update(subObject as Draft<DerivedValue>);
      });
    }
  );

  return result;
};

type ImmerUpdateFnWithReturn<Value, ReturnContext> = (
  draft: Draft<Value>
) => ReturnContext;

export type LinkedEffectUpdateTuple<Value, ReturnContext, EffectResult> = {
  update?: ImmerUpdateFnWithReturn<Value, ReturnContext>;
  effect?: (next: Value, context: ReturnContext) => Promise<EffectResult>;
  postEffect?: (
    draft: Draft<Value>,
    effectResult: EffectResult
  ) => void | Promise<void>;
};

type Updater<Value, ReturnContext = unknown, EffectResult = unknown> = {
  update: <NewReturnContext>(
    updateFn: (draft: Draft<Value>) => NewReturnContext
  ) => Updater<Value, NewReturnContext, unknown>;
  effect: <NewEffectResult>(
    effectFn: (next: Value, context: ReturnContext) => Promise<NewEffectResult>
  ) => Updater<Value, ReturnContext, NewEffectResult>;
  postEffect: (
    postEffectFn: (draft: Draft<Value>, effectResult: EffectResult) => void
  ) => Updater<Value, ReturnContext, EffectResult>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SagaBuilderWithoutVerification = Updater<any, any, any>;

type Saga<Value, ReturnContext, EffectResult> = {
  update?: ImmerUpdateFnWithReturn<Value, ReturnContext>;
  effect?: (next: Value, context: ReturnContext) => Promise<EffectResult>;
  postEffect?: (
    draft: Draft<Value>,
    effectResult: EffectResult
  ) => void | Promise<void>;
  onError?: (error: Error, draft: Draft<Value>) => void;
};

type SagaBuilder<Value, ReturnContext = unknown, EffectResult = unknown> = {
  update: <NewReturnContext>(
    updateFn: (draft: Draft<Value>) => NewReturnContext
  ) => SagaBuilder<Value, NewReturnContext, unknown>;
  effect: <NewEffectResult>(
    effectFn: (next: Value, context: ReturnContext) => Promise<NewEffectResult>
  ) => SagaBuilder<Value, ReturnContext, NewEffectResult>;
  postEffect: (
    postEffectFn: (draft: Draft<Value>, effectResult: EffectResult) => void
  ) => SagaBuilder<Value, ReturnContext, EffectResult>;
};

type SagaBuilderProvider<Value> = (sagaBuilder: SagaBuilder<Value>) => void;

export const useAtomImmerSaga = <Value extends Objectish>(
  atom: WritableAtom<Value, [(draft: Draft<Value>) => void], void>
) => {
  const atomValue = useAtomValue(atom);
  const setAtomValue = useSetAtom(atom);

  const runSaga = (sagaCollectorFn: SagaBuilderProvider<Value>) => {
    const saga: Saga<Value, unknown, unknown> = {};

    // Define the saga collector
    const collector: SagaBuilder<Value> = {
      update: (updateFn) => {
        saga.update = updateFn;
        return collector as SagaBuilderWithoutVerification;
      },
      effect: (effectFn) => {
        saga.effect = effectFn;
        return collector as SagaBuilderWithoutVerification;
      },
      postEffect: (postEffectFn) => {
        saga.postEffect = postEffectFn;
        return collector as SagaBuilderWithoutVerification;
      },
    };

    // Collect the saga
    sagaCollectorFn(collector);

    // Run the saga
    const runUpdate = saga.update;
    const runEffect = saga.effect;
    const runPostEffect = saga.postEffect;
    const onError = saga.onError;

    let resultContext: unknown;

    if (runUpdate) {
      let nextState: Value = undefined as unknown as Value;
      let inversePatches: Patch[] = [];

      // Rerender happens from optimistic update
      setAtomValue((originalDraft) => {
        // originalDraft is the latest state - we can only access the latest state in draft form
        const [nestedNextState, nestedPatches, nestedInversePatches] =
          produceWithPatches(originalDraft as Value, (nestedDraft) => {
            resultContext = runUpdate(nestedDraft);
          });

        // Now, the draft has already been modified
        // No need to return anything
        applyPatches(originalDraft, nestedPatches);
        nextState = nestedNextState;
        inversePatches = nestedInversePatches;
      });

      // Run the effect
      if (runEffect) {
        runEffect(nextState, resultContext)
          .then((effectResult) => {
            // On success, run the post effect hook with the effect result
            if (runPostEffect) {
              setAtomValue((draft) => {
                runPostEffect(draft, effectResult);
              });
            }
          })
          .catch((error) => {
            // On error, undo the original update patches
            // There is an error here because there's no get
            // TODO - ensure we use latest state
            setAtomValue((draft) => {
              applyPatches(draft, inversePatches);
            });

            if (onError) {
              setAtomValue((draft) => {
                onError(error, draft);
              });
            }
          });
      }
    }
  };

  const resultTuple: [Value, typeof runSaga] = [atomValue, runSaga];
  return resultTuple;
};
