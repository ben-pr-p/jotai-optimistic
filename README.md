# jotai-optimistic

A highly opinionated approach to optimistic updates with Jotai and Immer.

Mutate your state optimistically, run your network request, and don't worry
about rolling back the optimistic update if the network request fails.

# Motivation

Optimistic updates are hard.

In order to implement them properly, you need to:

1. Make some set of changes to your state
2. Kick off some asynchronous action to sync that state with the server
3. If there's an error, roll back just the changes you made in step 1

Step 3 is of course the hard part, especially if your action is modifying some deeply nested attribute of a larger state object. If you do some naive implementation like:
1. Take a snapshot of your state
2. Make some set of changes to your state
3. Kick off some asynchronous action to sync the state
4. If there's an error, restore the snapshot you took in step 1

You will have a bug that involves resetting any other changes to the state that happened in the interim. No good!

# Solution

The solution is a hook, called `useAtomImmerSaga`. Here's what it looks like to use it in a section of code responsible for updating the value of a toggle representing whether a particular relationship is directed or has no direction.

```typescript
export const useRelationshipKindHasDirection = (
  id: IDTypes["relationshipKind"]
) => {
  const [relationshipKind, runSaga] = useAtomImmerSaga(
    relationshipKindByIdAtomFamily(id)
  );

  const setHasDirection = (hasDirection: boolean) =>
    runSaga((saga) =>
      saga
        .update((draft) => {
          draft.has_direction = hasDirection;
        })
        .effect(async (_nextState, _relationshipKind) => {
          await trpc.updateRelationshipKind.mutate({
            id: id,
            patch: { has_direction: hasDirection },
          });
        })
        .onError((draft, error) => {
          draft.error = error.toString();
        })
    );

  return [relationshipKind.has_direction, setHasDirection] as const;
};
```


And this is what it looks like to build a component using that hook:

```typescript
const EditableRelationshipHasDirection = ({ id }: {
  id: IDTypes["relationshipKind"];
}) => {
  const [hasDirection, setHasDirection] = useRelationshipKindHasDirection(id);

  return (
    <button
    type="button"
    onClick={() => setHasDirection(!hasDirection)}
    />
  );
};
```

I think it's pretty great! You get a hook that abstracts the network call, the application of the optimistic update, and its rollback in the event of a network failure.

The key bit is the typed saga, which has `.update`, `.effect`, and `.postEffect`` methods.

The `.update` method is applied immediately - that's the optimistic state update, which, thanks to immer, you can just apply via easy imperative object mutation.

The `.effect` method contains the network call or other asynchronous side effect of the user action. If it throws, the changes applied during the `.update` method and only those changes will be rolled back. The full state will not be reset to what it was before the network mutation.

There is also a `.postEffect` method for applying some state update after the network call has succeeded. I was originally using it to plug in a server generated ID,
but I have since switched to using client side generated branded IDs for my particular project.  I'm going to keep it around for a while to make sure I don't need it for anything else.

# Other Exports

There are a few other exports here that are useful.

## `createDerivedImmerAtom`

This function can help create a derived, "immerified" atom from a larger atom that you can run optimistic updates with.

```typescript
import { createDerivedImmerAtom } from 'jotai-optimistic';

const bigAtomWithNestedObjects = atomWithImmer({
  bigListOfEntities: [
    {
      name: 'a',
      count: 42
    },
    {
      name: 'j',
      count: 89
    }
  ],
  anotherObject: {
    nestedDate: new Date(),
    nestedNumber: 1
  }
});

const aAtomWithImmer = createDerivedImmerAtom(
  bigAtomWithNestedObjects,
  bawno => bawno.bigListOfEntities.find(entity => entity.find(name === 'a'))
);

const anotherObjectAtom = createDerivedImmerAtom(
  bigAtomWithNestedObjects,
  bawno => bawno.anotherObject
);
```

`aAtomWithImmer` is now writeable, and nicely write-able with Immer style draft functions, and I haven't had to write any setter for it.

For example, I can do:

```typescript
const EditAnotherObjectName = () => {
  const [anotherObject, setAnotherObject] = useAtom(anotherObjectAtom)

  return (
    <input value={anotherObject.name}
      onChange={ev => {
      setAnotherObject(draft => {
        draft.name = ev.target.value
      })
      }
    />
  );
}
```

## `useSetInitialAtomValueFromQuery`

With derived atoms, the possibility of an atom being `undefined` can be really annoying, since you have to handle it
for it with every single derivation. This is also true if an atom is async - every atom which reads from it has to be async as well.

I have found it easier to instead initialize the atom to an empty but not undefined object state, and then use `useSetInitialAtomValueFromQuery` 
to set the initial value of the atom from a query once it comes back.

Suppose `trpc.getDocuments()` returns `{ id: string, title: string, body: string }[]`

I would:
```typescript
import { useAtomValue } from 'jotai';
import { atomWithImmer } from 'jotai-immer';
import { useSetInitialAtomValueFromQuery } from 'jotai-optimistic';

const documentsAtom = atomWithImmer([]);

const MyComponent = () => {
  const documents = useAtomValue(documentsAtom);

  const { data: documentsData, loading: documentsAreLoading } = trpc.useQuery.getDocuments()

  useSetInitialAtomValueFromQuery(
    documentsAtom, 
    documentsData, 
    documentsAreLoading
  )


  return documents.map(
    // some list of documents
  )
}
```


