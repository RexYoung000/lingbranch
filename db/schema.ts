import { sqliteTable, text, integer, real, index, uniqueIndex, check } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const ideas=sqliteTable('ideas',{
  seq:integer('seq').primaryKey({autoIncrement:true}),id:text('id').notNull().unique(),
  title:text('title').notNull(),body:text('body').notNull(),bodyFormat:text('body_format').notNull().default('plain'),sourceLabel:text('source_label').notNull(),
  sourceUrl:text('source_url').notNull(),sourceAt:text('source_at').notNull(),tagsJson:text('tags_json').notNull(),
  x:real('x').notNull(),y:real('y').notNull(),archived:integer('archived').notNull(),
  createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},t=>[check('ideas_archived',sql`${t.archived} IN (0,1)`)]);
export const attachments=sqliteTable('attachments',{
  id:text('id').primaryKey(),ideaId:text('idea_id').notNull().references(()=>ideas.id),name:text('name').notNull(),
  mimeType:text('mime_type').notNull(),bytes:integer('bytes').notNull(),indexedText:text('indexed_text').notNull(),
  sha256:text('sha256').notNull(),createdAt:text('created_at').notNull(),
},t=>[index('idx_attachments_idea_id').on(t.ideaId)]);
export const connections=sqliteTable('connections',{
  id:text('id').primaryKey(),fromId:text('from_id').notNull().references(()=>ideas.id),toId:text('to_id').notNull().references(()=>ideas.id),
  relationType:text('relation_type').notNull().default('related'),reason:text('reason').notNull().default(''),updatedAt:text('updated_at').notNull().default('1970-01-01T00:00:00.000Z'),
},t=>[uniqueIndex('idx_connections_pair').on(t.fromId,t.toId),check('connections_canonical_pair',sql`${t.fromId} < ${t.toId}`)]);
export const canvas=sqliteTable('canvas',{
  id:integer('id').primaryKey(),panX:real('pan_x').notNull(),panY:real('pan_y').notNull(),
  zoom:real('zoom').notNull(),updatedAt:text('updated_at').notNull(),revision:integer('revision').notNull(),
},t=>[check('canvas_singleton',sql`${t.id}=1`)]);
export const receipts=sqliteTable('receipts',{key:text('key').primaryKey(),hash:text('hash').notNull(),result:text('result').notNull()});
// A NOT NULL assertion makes a failed compare-and-swap roll back the entire D1 batch.
export const mutationGuard=sqliteTable('mutation_guard',{id:text('id').primaryKey(),valid:integer('valid').notNull()});
