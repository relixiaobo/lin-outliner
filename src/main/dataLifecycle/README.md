# Data lifecycle

The data lifecycle owner implements the local compatibility, backup, and
recovery feature from [the foundation plan](../../../docs/plans/data-compatibility-foundation.md).
It coordinates physical Store adapters and existing Runtime ownership. Store
owners remain responsible for schema and semantic validation; Desktop lifecycle
remains responsible for window visibility, retry, and quit.

The renderer protocol uses opaque operation and backup IDs. Recovery journals
and admission fences are outside the data they replace. Historical restoration
does not restore automatic execution authority or future sync admission.

Implementation and validation of this feature are kept together in its PR.
