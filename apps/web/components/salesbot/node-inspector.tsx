'use client';
import { FlowNode, NodeType, getNodeMeta, NODE_TYPES } from './node-types';
import { X, Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';

interface NodeInspectorProps {
  node: FlowNode | null;
  allNodes: FlowNode[];
  onUpdate: (node: FlowNode) => void;
  onClose: () => void;
}

function cfg(node: FlowNode, key: string): string {
  return String(node.config[key] ?? '');
}

function set(node: FlowNode, key: string, value: unknown): FlowNode {
  return { ...node, config: { ...node.config, [key]: value } };
}

export function NodeInspector({ node, allNodes, onUpdate, onClose }: NodeInspectorProps) {
  if (!node) return null;
  const meta = getNodeMeta(node.type);

  const u = (key: string, value: unknown) => onUpdate(set(node, key, value));

  const listItems: string[] = Array.isArray(node.config.items) ? (node.config.items as string[]) : [];
  const agents: string[] = Array.isArray(node.config.agents) ? (node.config.agents as string[]) : [];

  return (
    <aside className="w-72 border-l border-af-border bg-white flex flex-col flex-shrink-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-af-border">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg text-white" style={{ backgroundColor: meta.color }}>
            {meta.icon}
          </span>
          <span className="text-sm font-semibold text-slate-900">{meta.label}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <p className="text-xs text-slate-500 italic">{meta.description}</p>

        <Input
          label="Rótulo do nó"
          value={node.label}
          onChange={(e) => onUpdate({ ...node, label: e.target.value })}
        />

        {/* ─── send_message ─── */}
        {node.type === 'send_message' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Mensagem</label>
              <textarea
                value={cfg(node, 'message')}
                onChange={(e) => u('message', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={4}
                placeholder="Digite a mensagem que será enviada..."
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Atraso (segundos)</label>
              <input
                type="number"
                value={cfg(node, 'delay') || '0'}
                onChange={(e) => u('delay', e.target.value)}
                min={0}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              />
            </div>
          </>
        )}

        {/* ─── reaction ─── */}
        {node.type === 'reaction' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Emoji da reação</label>
              <div className="flex flex-wrap gap-2">
                {['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '✅', '⭐'].map((e) => (
                  <button
                    key={e}
                    onClick={() => u('emoji', e)}
                    className={`text-xl p-1.5 rounded-lg border-2 transition-colors ${cfg(node, 'emoji') === e ? 'border-af-accent bg-blue-50' : 'border-af-border hover:border-af-mid'}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {cfg(node, 'emoji') && (
                <p className="text-xs text-slate-500 mt-1">Selecionado: {cfg(node, 'emoji')}</p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Reagir à mensagem</label>
              <select
                value={cfg(node, 'target') || 'last'}
                onChange={(e) => u('target', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="last">Última mensagem do lead</option>
                <option value="first">Primeira mensagem do fluxo</option>
              </select>
            </div>
          </>
        )}

        {/* ─── comment ─── */}
        {node.type === 'comment' && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700">Comentário</label>
            <textarea
              value={cfg(node, 'comment')}
              onChange={(e) => u('comment', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
              rows={4}
              placeholder="Escreva o comentário interno da conversa..."
            />
          </div>
        )}

        {/* ─── internal_message ─── */}
        {node.type === 'internal_message' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Mensagem interna</label>
              <textarea
                value={cfg(node, 'message')}
                onChange={(e) => u('message', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={4}
                placeholder="Mensagem visível apenas para a equipe..."
              />
            </div>
            <Input
              label="Mencionar agente (opcional)"
              value={cfg(node, 'mention')}
              onChange={(e) => u('mention', e.target.value)}
              placeholder="@nome do agente"
            />
          </>
        )}

        {/* ─── list_message ─── */}
        {node.type === 'list_message' && (
          <>
            <Input
              label="Título da lista"
              value={cfg(node, 'title')}
              onChange={(e) => u('title', e.target.value)}
              placeholder="Ex: Escolha uma opção"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Corpo da mensagem</label>
              <textarea
                value={cfg(node, 'body')}
                onChange={(e) => u('body', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={3}
                placeholder="Texto de introdução da lista..."
              />
            </div>
            <Input
              label="Texto do botão"
              value={cfg(node, 'buttonText')}
              onChange={(e) => u('buttonText', e.target.value)}
              placeholder="Ex: Ver opções"
            />
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700">Itens da lista</label>
              {listItems.map((item, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={item}
                    onChange={(e) => {
                      const arr = [...listItems];
                      arr[i] = e.target.value;
                      u('items', arr);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    placeholder={`Opção ${i + 1}`}
                  />
                  <button onClick={() => u('items', listItems.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => u('items', [...listItems, ''])}
                className="flex items-center gap-1 text-xs text-af-accent hover:text-af-mid font-medium"
              >
                <Plus size={12} /> Adicionar item
              </button>
            </div>
          </>
        )}

        {/* ─── pause ─── */}
        {node.type === 'pause' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de pausa</label>
              <select
                value={cfg(node, 'pauseType') || 'time'}
                onChange={(e) => u('pauseType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="time">Aguardar por tempo</option>
                <option value="response">Aguardar resposta do lead</option>
                <option value="event">Aguardar evento</option>
              </select>
            </div>
            {(cfg(node, 'pauseType') || 'time') === 'time' && (
              <div className="flex gap-2">
                <input
                  type="number"
                  value={cfg(node, 'duration') || '1'}
                  onChange={(e) => u('duration', e.target.value)}
                  min={1}
                  className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                />
                <select
                  value={cfg(node, 'unit') || 'hours'}
                  onChange={(e) => u('unit', e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="minutes">Minutos</option>
                  <option value="hours">Horas</option>
                  <option value="days">Dias</option>
                </select>
              </div>
            )}
            {cfg(node, 'pauseType') === 'response' && (
              <Input
                label="Timeout (horas)"
                type="number"
                value={cfg(node, 'timeout') || '24'}
                onChange={(e) => u('timeout', e.target.value)}
              />
            )}
          </>
        )}

        {/* ─── subscribe_meta ─── */}
        {node.type === 'subscribe_meta' && (
          <>
            <Input
              label="ID da sequência Meta"
              value={cfg(node, 'sequenceId')}
              onChange={(e) => u('sequenceId', e.target.value)}
              placeholder="ID da sequência no Meta"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de inscrição</label>
              <select
                value={cfg(node, 'subType') || 'sequence'}
                onChange={(e) => u('subType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="sequence">Sequência</option>
                <option value="broadcast">Broadcast</option>
                <option value="tag">Tag</option>
              </select>
            </div>
          </>
        )}

        {/* ─── action ─── */}
        {node.type === 'action' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de ação</label>
              <select
                value={cfg(node, 'actionType') || 'assign'}
                onChange={(e) => u('actionType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="assign">Atribuir a agente</option>
                <option value="move_stage">Mover estágio</option>
                <option value="add_tag">Adicionar tag</option>
                <option value="remove_tag">Remover tag</option>
                <option value="set_field">Definir campo</option>
                <option value="webhook">Disparar webhook</option>
              </select>
            </div>
            {cfg(node, 'actionType') === 'assign' && (
              <Input label="ID do agente" value={cfg(node, 'agentId')} onChange={(e) => u('agentId', e.target.value)} placeholder="ID do agente" />
            )}
            {cfg(node, 'actionType') === 'move_stage' && (
              <Input label="ID do estágio" value={cfg(node, 'stageId')} onChange={(e) => u('stageId', e.target.value)} placeholder="ID do estágio" />
            )}
            {(cfg(node, 'actionType') === 'add_tag' || cfg(node, 'actionType') === 'remove_tag') && (
              <Input label="Tag" value={cfg(node, 'tag')} onChange={(e) => u('tag', e.target.value)} placeholder="nome-da-tag" />
            )}
            {cfg(node, 'actionType') === 'set_field' && (
              <>
                <Input label="Campo" value={cfg(node, 'fieldName')} onChange={(e) => u('fieldName', e.target.value)} placeholder="Ex: status" />
                <Input label="Valor" value={cfg(node, 'fieldValue')} onChange={(e) => u('fieldValue', e.target.value)} placeholder="Ex: qualificado" />
              </>
            )}
            {cfg(node, 'actionType') === 'webhook' && (
              <Input label="URL do Webhook" value={cfg(node, 'webhookUrl')} onChange={(e) => u('webhookUrl', e.target.value)} placeholder="https://..." />
            )}
          </>
        )}

        {/* ─── condition ─── */}
        {node.type === 'condition' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Campo a verificar</label>
              <select
                value={cfg(node, 'field')}
                onChange={(e) => u('field', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Selecione...</option>
                <option value="last_message">Última mensagem</option>
                <option value="name">Nome</option>
                <option value="email">E-mail</option>
                <option value="phone">Telefone</option>
                <option value="stage">Estágio atual</option>
                <option value="tag">Tag</option>
                <option value="custom">Campo personalizado</option>
              </select>
            </div>
            {cfg(node, 'field') === 'custom' && (
              <Input label="Nome do campo" value={cfg(node, 'customField')} onChange={(e) => u('customField', e.target.value)} placeholder="nome_campo" />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Operador</label>
              <select
                value={cfg(node, 'operator') || 'equals'}
                onChange={(e) => u('operator', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="equals">É igual a</option>
                <option value="not_equals">Não é igual a</option>
                <option value="contains">Contém</option>
                <option value="not_contains">Não contém</option>
                <option value="starts_with">Começa com</option>
                <option value="exists">Existe (preenchido)</option>
                <option value="not_exists">Não existe</option>
              </select>
            </div>
            {cfg(node, 'operator') !== 'exists' && cfg(node, 'operator') !== 'not_exists' && (
              <Input label="Valor" value={cfg(node, 'value')} onChange={(e) => u('value', e.target.value)} placeholder="Ex: sim" />
            )}
          </>
        )}

        {/* ─── validation ─── */}
        {node.type === 'validation' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de validação</label>
              <select
                value={cfg(node, 'validationType') || 'email'}
                onChange={(e) => u('validationType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="email">E-mail válido</option>
                <option value="phone">Telefone válido</option>
                <option value="cpf">CPF válido</option>
                <option value="cnpj">CNPJ válido</option>
                <option value="number">Número</option>
                <option value="text">Texto (não vazio)</option>
                <option value="regex">Expressão regular</option>
              </select>
            </div>
            <Input label="Campo a validar" value={cfg(node, 'field')} onChange={(e) => u('field', e.target.value)} placeholder="Ex: email" />
            {cfg(node, 'validationType') === 'regex' && (
              <Input label="Expressão regular" value={cfg(node, 'regex')} onChange={(e) => u('regex', e.target.value)} placeholder="^[0-9]+$" />
            )}
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Mensagem de erro</label>
              <textarea
                value={cfg(node, 'errorMessage')}
                onChange={(e) => u('errorMessage', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={2}
                placeholder="Por favor, informe um valor válido."
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="retryValidation"
                checked={!!node.config.retry}
                onChange={(e) => u('retry', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="retryValidation" className="text-sm text-slate-700">Repetir até valor válido</label>
            </div>
          </>
        )}

        {/* ─── goto_step ─── */}
        {node.type === 'goto_step' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Ir para o nó</label>
              <select
                value={cfg(node, 'targetNodeId')}
                onChange={(e) => u('targetNodeId', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Selecione um nó...</option>
                {allNodes.filter(n => n.id !== node.id).map(n => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* ─── start_salesbot ─── */}
        {node.type === 'start_salesbot' && (
          <>
            <Input
              label="ID do Salesbot"
              value={cfg(node, 'botId')}
              onChange={(e) => u('botId', e.target.value)}
              placeholder="ID do bot a iniciar"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Comportamento</label>
              <select
                value={cfg(node, 'behavior') || 'replace'}
                onChange={(e) => u('behavior', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="replace">Substituir fluxo atual</option>
                <option value="parallel">Executar em paralelo</option>
              </select>
            </div>
          </>
        )}

        {/* ─── custom_step ─── */}
        {node.type === 'custom_step' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Código JavaScript</label>
              <textarea
                value={cfg(node, 'code')}
                onChange={(e) => u('code', e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent bg-slate-950 text-green-400"
                rows={8}
                placeholder={'// Variáveis disponíveis:\n// lead, context, send(msg)\n\nconst nome = lead.name;\nsend(`Olá, ${nome}!`);'}
              />
            </div>
            <p className="text-xs text-slate-400">Use <code>lead</code>, <code>context</code> e <code>send()</code> para interagir com o fluxo.</p>
          </>
        )}

        {/* ─── widget ─── */}
        {node.type === 'widget' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Tipo de widget</label>
              <select
                value={cfg(node, 'widgetType') || 'button'}
                onChange={(e) => u('widgetType', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="button">Botões de resposta rápida</option>
                <option value="form">Formulário</option>
                <option value="calendar">Agendamento</option>
                <option value="payment">Pagamento</option>
              </select>
            </div>
            <Input label="Título" value={cfg(node, 'title')} onChange={(e) => u('title', e.target.value)} placeholder="Título do widget" />
            {cfg(node, 'widgetType') === 'button' && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-slate-700">Botões</label>
                {listItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={item}
                      onChange={(e) => {
                        const arr = [...listItems];
                        arr[i] = e.target.value;
                        u('items', arr);
                      }}
                      className="flex-1 px-2 py-1.5 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                      placeholder={`Botão ${i + 1}`}
                    />
                    <button onClick={() => u('items', listItems.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button onClick={() => u('items', [...listItems, ''])} className="flex items-center gap-1 text-xs text-af-accent hover:text-af-mid font-medium">
                  <Plus size={12} /> Adicionar botão
                </button>
              </div>
            )}
          </>
        )}

        {/* ─── round_robin ─── */}
        {node.type === 'round_robin' && (
          <>
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-slate-700">Agentes no rodízio</label>
              {agents.map((agent, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    value={agent}
                    onChange={(e) => {
                      const arr = [...agents];
                      arr[i] = e.target.value;
                      u('agents', arr);
                    }}
                    className="flex-1 px-2 py-1.5 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
                    placeholder={`Agente ${i + 1}`}
                  />
                  <button onClick={() => u('agents', agents.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button onClick={() => u('agents', [...agents, ''])} className="flex items-center gap-1 text-xs text-af-accent hover:text-af-mid font-medium">
                <Plus size={12} /> Adicionar agente
              </button>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Estratégia</label>
              <select
                value={cfg(node, 'strategy') || 'round_robin'}
                onChange={(e) => u('strategy', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="round_robin">Rodízio sequencial</option>
                <option value="least_busy">Menos ocupado</option>
                <option value="random">Aleatório</option>
              </select>
            </div>
          </>
        )}

        {/* ─── stop_salesbot ─── */}
        {node.type === 'stop_salesbot' && (
          <>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Motivo (opcional)</label>
              <select
                value={cfg(node, 'reason') || 'completed'}
                onChange={(e) => u('reason', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="completed">Fluxo concluído</option>
                <option value="unsubscribed">Lead optou por sair</option>
                <option value="transferred">Transferido para humano</option>
                <option value="error">Erro no fluxo</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sendFinalMsg"
                checked={!!node.config.sendFinalMessage}
                onChange={(e) => u('sendFinalMessage', e.target.checked)}
                className="rounded"
              />
              <label htmlFor="sendFinalMsg" className="text-sm text-slate-700">Enviar mensagem de encerramento</label>
            </div>
            {!!node.config.sendFinalMessage && (
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-slate-700">Mensagem final</label>
                <textarea
                  value={cfg(node, 'finalMessage')}
                  onChange={(e) => u('finalMessage', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                  rows={3}
                  placeholder="Obrigado pelo contato! Até logo."
                />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
