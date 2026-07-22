# Agent Full Access And Capability Boundary

Tenon treats the agent as a delegated local operator. An accepted user request
authorizes execution of the tools visible in that Thread.

## Full Access

Available file and process tools execute with the host account's authority.
Relative paths start from the Thread working directory; absolute paths remain
valid. Shell commands run through the host shell. Network, provider, operating
system, and filesystem errors are returned natively.

Tenon does not add an agent filesystem sandbox, permission mode, approval policy,
or pause/resume authorization flow. `request_user_input` gathers missing product
input only and must never be used as a risk confirmation prompt.

Electron renderer security remains unchanged: context isolation, renderer
sandboxing, no Node integration, preload-only IPC, navigation denial, and the
permission allow-list protect the application boundary. Those controls are not
an agent capability mode.

## Capability Selection

Execution authority is shaped by four mechanisms:

1. The canonical model-tool catalog determines what the product can expose.
2. The effective Configuration Profile and Agent Role select a subset.
3. Parent configuration places a hard ceiling on every child capability source.
4. Explicit user blocks make matching action kinds unavailable.

Selection controls availability, not host-account authority. A tool that survives
selection runs directly; a tool that does not survive is absent or returns its
owner's structured unavailable result.

## Explicit Blocks

Blocks operate on normalized action descriptors such as outline read/write,
local file read/write/delete, shell execution classes, web access, publishing,
external messaging, Goal control, collaboration, Skill invocation, image
generation, and data import.

Command matching normalizes whitespace outside quotes while preserving quoted
content. Unknown shell behavior is classified conservatively. Blocks do not
silently rewrite a command into a safer variant.

Capability configuration is local host state. It is not Thread history and does
not travel through document synchronization.

## Native Failures

Operating-system denial, provider rejection, missing credentials, unavailable
network service, and command exit are execution results. The runtime records them
on the canonical Item and lets the model choose another available approach.

There is no fallback that asks the user to approve the same operation. Product
questions and capability failures remain separate flows.

## Capability Audit

Each executed or unavailable tool result records:

- canonical tool identity
- resolved action descriptors
- read or write access classification
- decision source
- unavailable code and reason when applicable

Audit data is attached to structured tool details and the corresponding Item.
Document operations also carry immutable Thread/Turn/Item causation in Core
transaction metadata.

## Shared Resource Concurrency

Full Access does not imply unsafe coordination. Existing subsystem owners retain
their serialization rules:

- `ThreadService` serializes Turn acceptance per Thread.
- `DocumentService` serializes document transactions.
- file tools use optimistic preconditions where their contract provides them.
- process handles identify exact live commands.
- external services enforce their own idempotency and consistency contracts.

Thread fork changes history context only. It does not compensate or reverse
effects on any shared resource.
