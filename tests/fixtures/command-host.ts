import { VersionStore } from '../../src/versions/store.ts';
import { Supervisor } from '../../src/runtime/supervisor.ts';
import { RuntimeClient } from '../../src/runtime/client.ts';

const [state, source, cwd, execution] = process.argv.slice(2);
const store = await VersionStore.open(state);
await store.initialize(source);
const supervisor = new Supervisor(store, cwd, JSON.parse(execution));
await supervisor.start();
const client = await RuntimeClient.connect(supervisor.socketPath);
process.send?.({ type: 'ready' });
try { await client.run('exercise host death'); }
catch (error) { process.send?.({ type: 'error', error: String(error) }); }
finally { client.close(); await supervisor.close(); store.close(); }
