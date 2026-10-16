import type { components } from './schema.gen'

export type User = components['schemas']['User']
export type Session = components['schemas']['Session']
export type SettingsPatch = components['schemas']['SettingsPatch']
export type ViewMode = components['schemas']['ViewMode']
export type SlotMinutes = components['schemas']['SlotMinutes']
export type Category = components['schemas']['Category']
export type Instance = components['schemas']['Instance']
export type CreateTaskRequest = components['schemas']['CreateTaskRequest']
export type UpdateInstanceRequest = components['schemas']['UpdateInstanceRequest']
export type Series = components['schemas']['Series']
export type Scope = 'this' | 'following' | 'all'
export type Deviation = components['schemas']['Deviation']
export type InstanceStatus = components['schemas']['InstanceStatus']
export type InstanceLink = components['schemas']['InstanceLink']
export type TrackingPatch = components['schemas']['TrackingPatch']
