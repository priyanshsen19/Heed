import { CURRENT_SCHEMA_VERSION, readItem, writeItem } from './storage';

/** Makes sure the local state shape version is recorded; migrations hook in here in later stages. */
export async function ensureSchemaVersion(): Promise<void> {
  const stored = await readItem('schemaVersion');
  if (stored === undefined || stored < CURRENT_SCHEMA_VERSION) {
    await writeItem('schemaVersion', CURRENT_SCHEMA_VERSION);
  }
}
