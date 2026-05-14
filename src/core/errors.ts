export class CoreError extends Error {
  readonly code: string;

  private constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }

  static nodeNotFound(id: string) {
    return new CoreError('NodeNotFound', `node not found: ${id}`);
  }

  static parentNotFound(id: string) {
    return new CoreError('ParentNotFound', `parent not found: ${id}`);
  }

  static lockedNode(id: string) {
    return new CoreError('LockedNode', `operation is not allowed on locked node: ${id}`);
  }

  static invalidMove() {
    return new CoreError('InvalidMove', 'cannot move a node into itself or its descendant');
  }

  static referenceCycle() {
    return new CoreError('ReferenceCycle', 'cannot create a reference cycle');
  }

  static noPreviousSibling() {
    return new CoreError('NoPreviousSibling', 'no previous sibling is available');
  }

  static noParent() {
    return new CoreError('NoParent', 'no parent is available');
  }

  static invalidOperation(message: string) {
    return new CoreError('InvalidOperation', `invalid operation: ${message}`);
  }
}

