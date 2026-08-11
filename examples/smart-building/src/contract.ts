import { ids, resultSchema, type StringSchema } from '@safescript/contracts';
import { defineContract, type ContractType } from '@safescript/sdk';

export interface BuildingSensorEvent {
  readonly buildingId: string;
  readonly zoneId: string;
  readonly temperatureTenths: bigint;
  readonly humidityPercent: bigint;
  readonly lightLux: bigint;
  readonly occupied: boolean;
}

export interface BuildingActionInput {
  readonly buildingId: string;
  readonly zoneId: string;
  readonly value: string;
}

export interface BuildingActionOutput {
  readonly accepted: boolean;
}

export type BuildingProgramResult = Readonly<{ tag: 'ok'; value: null }> | Readonly<{ tag: 'error'; value: string }>;

const string = (maxBytes = 256): StringSchema => ({ kind: 'string', maxBytes });
const eventType: ContractType<BuildingSensorEvent> = {
  id: ids.type('type:building.sensor-event'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'buildingId', schema: string() },
      { name: 'zoneId', schema: string() },
      { name: 'temperatureTenths', schema: { kind: 'int64' } },
      { name: 'humidityPercent', schema: { kind: 'int64' } },
      { name: 'lightLux', schema: { kind: 'int64' } },
      { name: 'occupied', schema: { kind: 'boolean' } },
    ],
  },
};
const actionInputType: ContractType<BuildingActionInput> = {
  id: ids.type('type:building.action-input'),
  schema: {
    kind: 'record',
    fields: [
      { name: 'buildingId', schema: string() },
      { name: 'zoneId', schema: string() },
      { name: 'value', schema: string(512) },
    ],
  },
};
const actionOutputType: ContractType<BuildingActionOutput> = {
  id: ids.type('type:building.action-output'),
  schema: { kind: 'record', fields: [{ name: 'accepted', schema: { kind: 'boolean' } }] },
};
const actionErrorType: ContractType<string> = {
  id: ids.type('type:building.action-error'),
  schema: string(256),
};
const programResultType: ContractType<BuildingProgramResult> = {
  id: ids.type('type:building.program-result'),
  schema: resultSchema({ kind: 'unit' }, { kind: 'ref', type: actionErrorType.id }),
};
const operation = (name: string, effectCost: number) => ({
  id: ids.operation(`operation:${name}`),
  input: actionInputType,
  output: actionOutputType,
  error: actionErrorType,
  effectCost,
});

export const buildingContract = defineContract({
  id: ids.contract('contract:example.smart-building'),
  operations: {
    setHvac: operation('hvac.set', 2),
    setLights: operation('lighting.set', 1),
    sendAlert: operation('alerts.send', 2),
    recordAudit: operation('audit.record', 1),
  },
  slots: {
    automation: {
      id: ids.slot('slot:building.automation'),
      input: eventType,
      output: programResultType,
      operations: [
        ids.operation('operation:hvac.set'),
        ids.operation('operation:lighting.set'),
        ids.operation('operation:alerts.send'),
        ids.operation('operation:audit.record'),
      ],
    },
  },
});
