/*******************************************************************

Part of the Fritzing project - http://fritzing.org

Fritzing is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

********************************************************************/

#include "copilotview.h"

#include <QComboBox>
#include <QFormLayout>
#include <QHBoxLayout>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QRegularExpression>
#include <QSettings>
#include <QTextBrowser>
#include <QUrl>
#include <QVBoxLayout>

namespace {

const int MaxActionRounds = 8;

struct ProviderInfo {
	const char * id;
	const char * label;
	QStringList models;
	const char * defaultBaseUrl;
};

QList<ProviderInfo> providers() {
	return {
		{ "openai", "OpenAI (ChatGPT)", { "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "o4-mini" }, "https://api.openai.com/v1" },
		{ "gemini", "Google Gemini", { "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash" }, "https://generativelanguage.googleapis.com/v1beta" },
		{ "anthropic", "Anthropic Claude", { "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-5" }, "https://api.anthropic.com/v1" },
		{ "custom", "Other (OpenAI-compatible: Ollama, OpenRouter, Groq, DeepSeek...)", { "llama3.1", "deepseek-chat", "mistral" }, "http://localhost:11434/v1" },
	};
}

// Enter sends, Shift+Enter adds a new line.
class ChatInput : public QPlainTextEdit {
public:
	std::function<void()> onSubmit;
	using QPlainTextEdit::QPlainTextEdit;
protected:
	void keyPressEvent(QKeyEvent * e) override {
		if ((e->key() == Qt::Key_Return || e->key() == Qt::Key_Enter) && !(e->modifiers() & Qt::ShiftModifier)) {
			if (onSubmit) onSubmit();
			return;
		}
		QPlainTextEdit::keyPressEvent(e);
	}
};

}

CopilotView::CopilotView(ActionExecutor executor, QWidget * parent)
	: QFrame(parent), m_executor(std::move(executor))
{
	setObjectName("CopilotView");
	m_network = new QNetworkAccessManager(this);

	auto * root = new QVBoxLayout(this);
	root->setContentsMargins(16, 12, 16, 12);

	auto * title = new QLabel(tr("<b>Fritzing Copilot</b> &mdash; describe a circuit and the AI will build it for you."));
	root->addWidget(title);

	// Settings row
	auto * form = new QFormLayout();
	m_provider = new QComboBox();
	for (const auto & p : providers()) m_provider->addItem(QString::fromUtf8(p.label), QString::fromUtf8(p.id));
	m_model = new QComboBox();
	m_model->setEditable(true);
	m_apiKey = new QLineEdit();
	m_apiKey->setEchoMode(QLineEdit::Password);
	m_apiKey->setPlaceholderText(tr("Paste your API key (stored locally in Fritzing settings)"));
	m_baseUrl = new QLineEdit();
	m_baseUrlLabel = new QLabel(tr("Base URL"));

	form->addRow(tr("Provider"), m_provider);
	form->addRow(tr("Model"), m_model);
	form->addRow(tr("API key"), m_apiKey);
	form->addRow(m_baseUrlLabel, m_baseUrl);
	root->addLayout(form);

	m_transcript = new QTextBrowser();
	m_transcript->setOpenExternalLinks(true);
	root->addWidget(m_transcript, 1);

	auto * inputRow = new QHBoxLayout();
	auto * input = new ChatInput();
	input->onSubmit = [this]() { sendClicked(); };
	m_input = input;
	m_input->setPlaceholderText(tr("e.g. \"Build an Arduino Uno blinking an LED on pin 13 through a 220 ohm resistor\"  (Enter to send, Shift+Enter for new line)"));
	m_input->setMaximumHeight(90);
	inputRow->addWidget(m_input, 1);

	auto * buttons = new QVBoxLayout();
	m_send = new QPushButton(tr("Send"));
	auto * clear = new QPushButton(tr("New chat"));
	buttons->addWidget(m_send);
	buttons->addWidget(clear);
	inputRow->addLayout(buttons);
	root->addLayout(inputRow);

	m_status = new QLabel();
	root->addWidget(m_status);

	connect(m_send, &QPushButton::clicked, this, &CopilotView::sendClicked);
	connect(clear, &QPushButton::clicked, this, &CopilotView::clearChat);
	connect(m_provider, qOverload<int>(&QComboBox::currentIndexChanged), this, &CopilotView::providerChanged);
	connect(m_apiKey, &QLineEdit::editingFinished, this, &CopilotView::saveSettings);
	connect(m_baseUrl, &QLineEdit::editingFinished, this, &CopilotView::saveSettings);
	connect(m_model, &QComboBox::currentTextChanged, this, &CopilotView::saveSettings);

	loadSettings();
	appendBubble(tr("Copilot"), tr("Hi! Pick a provider, paste your API key, then tell me what to build. "
	                               "I can search parts, place them, wire them together, delete parts, switch views, autoroute and save."), "#2e7d32");
}

QString CopilotView::providerId() const {
	return m_provider->currentData().toString();
}

void CopilotView::loadSettings() {
	QSettings settings;
	QString id = settings.value("copilot/provider", "openai").toString();
	int ix = m_provider->findData(id);
	m_provider->blockSignals(true);
	m_provider->setCurrentIndex(ix < 0 ? 0 : ix);
	m_provider->blockSignals(false);
	providerChanged(m_provider->currentIndex());
}

void CopilotView::providerChanged(int index) {
	auto list = providers();
	if (index < 0 || index >= list.count()) return;
	const auto & p = list.at(index);
	QSettings settings;
	QString id = QString::fromUtf8(p.id);
	settings.setValue("copilot/provider", id);

	m_model->blockSignals(true);
	m_model->clear();
	m_model->addItems(p.models);
	m_model->setCurrentText(settings.value("copilot/" + id + "/model", p.models.first()).toString());
	m_model->blockSignals(false);

	m_apiKey->setText(settings.value("copilot/" + id + "/key").toString());
	m_baseUrl->setText(settings.value("copilot/" + id + "/baseUrl", QString::fromUtf8(p.defaultBaseUrl)).toString());
	bool showBase = (id == "custom");
	m_baseUrl->setVisible(showBase);
	m_baseUrlLabel->setVisible(showBase);
	m_apiKey->setPlaceholderText(id == "custom" ? tr("API key (leave empty for local Ollama)")
	                                            : tr("Paste your API key (stored locally in Fritzing settings)"));
}

void CopilotView::saveSettings() {
	QSettings settings;
	QString id = providerId();
	settings.setValue("copilot/" + id + "/model", m_model->currentText());
	settings.setValue("copilot/" + id + "/key", m_apiKey->text().trimmed());
	settings.setValue("copilot/" + id + "/baseUrl", m_baseUrl->text().trimmed());
}

void CopilotView::clearChat() {
	if (m_busy) return;
	m_messages = QJsonArray();
	m_transcript->clear();
	m_status->clear();
}

void CopilotView::appendBubble(const QString & who, const QString & text, const QString & color) {
	QString body = text.toHtmlEscaped();
	body.replace("\n", "<br>");
	m_transcript->append(QString("<p><b style='color:%1'>%2:</b><br>%3</p>").arg(color, who.toHtmlEscaped(), body));
}

void CopilotView::setBusy(bool busy) {
	m_busy = busy;
	m_send->setEnabled(!busy);
	m_status->setText(busy ? tr("Thinking...") : QString());
}

void CopilotView::sendClicked() {
	if (m_busy) return;
	QString text = m_input->toPlainText().trimmed();
	if (text.isEmpty()) return;
	if (m_apiKey->text().trimmed().isEmpty() && providerId() != "custom") {
		m_status->setText(tr("Please enter an API key first."));
		return;
	}
	saveSettings();
	m_input->clear();
	appendBubble(tr("You"), text, "#1565c0");
	m_messages.append(QJsonObject{ { "role", "user" }, { "content", text } });
	m_actionRounds = 0;
	requestCompletion();
}

QString CopilotView::systemPrompt() const {
	return QStringLiteral(
	    "You are Fritzing Copilot, an assistant embedded in the Fritzing electronics design app. "
	    "You build and edit circuits for the user by issuing actions.\n\n"
	    "To act, include ONE fenced block in your reply exactly like:\n"
	    "```actions\n[ {\"action\": \"search_parts\", \"query\": \"arduino uno\"} ]\n```\n"
	    "The actions run in order and their JSON results are sent back to you in the next message, "
	    "so you can chain steps (search first, then add using the returned moduleID, then read the connectors, then connect). "
	    "When the task is finished, reply WITHOUT an actions block and summarise what you did.\n\n"
	    "Available actions:\n"
	    "- {\"action\":\"search_parts\",\"query\":text}  -> matching parts with moduleID and title\n"
	    "- {\"action\":\"add_part\",\"moduleID\":id}  -> adds the part to the sketch; returns its item id and connectors\n"
	    "- {\"action\":\"list_parts\"}  -> parts currently in the sketch\n"
	    "- {\"action\":\"get_connectors\",\"id\":itemId}  -> connector ids and names of a placed part\n"
	    "- {\"action\":\"connect\",\"fromId\":itemId,\"fromConnector\":idOrName,\"toId\":itemId,\"toConnector\":idOrName}  -> draws a wire in breadboard view\n"
	    "- {\"action\":\"delete_part\",\"id\":itemId}\n"
	    "- {\"action\":\"switch_view\",\"view\":\"breadboard\"|\"schematic\"|\"pcb\"}\n"
	    "- {\"action\":\"autoroute\"}  -> autoroutes the current view\n"
	    "- {\"action\":\"undo\"} / {\"action\":\"redo\"} / {\"action\":\"save\"}\n\n"
	    "Tips: core parts include resistors (search 'resistor'), LEDs ('red LED'), 'Arduino Uno (Rev3)', 'battery', 'pushbutton', 'breadboard'. "
	    "Prefer connecting wires directly between part connectors rather than using a breadboard. "
	    "Always use exact connector ids or names returned by get_connectors/add_part. Keep replies short.");
}

void CopilotView::requestCompletion() {
	setBusy(true);
	QString id = providerId();
	QString model = m_model->currentText().trimmed();
	QString key = m_apiKey->text().trimmed();

	QNetworkRequest request;
	request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
	request.setTransferTimeout(180000);
	QJsonObject body;

	if (id == "gemini") {
		request.setUrl(QUrl(QString("https://generativelanguage.googleapis.com/v1beta/models/%1:generateContent").arg(model)));
		request.setRawHeader("x-goog-api-key", key.toUtf8());
		QJsonArray contents;
		for (const auto & v : m_messages) {
			QJsonObject m = v.toObject();
			QString role = m["role"].toString() == "assistant" ? "model" : "user";
			contents.append(QJsonObject{ { "role", role },
			                             { "parts", QJsonArray{ QJsonObject{ { "text", m["content"].toString() } } } } });
		}
		body["contents"] = contents;
		body["systemInstruction"] = QJsonObject{ { "parts", QJsonArray{ QJsonObject{ { "text", systemPrompt() } } } } };
	}
	else if (id == "anthropic") {
		request.setUrl(QUrl("https://api.anthropic.com/v1/messages"));
		request.setRawHeader("x-api-key", key.toUtf8());
		request.setRawHeader("anthropic-version", "2023-06-01");
		body["model"] = model;
		body["max_tokens"] = 4096;
		body["system"] = systemPrompt();
		body["messages"] = m_messages;
	}
	else {
		QString base = (id == "custom") ? m_baseUrl->text().trimmed() : QString("https://api.openai.com/v1");
		while (base.endsWith('/')) base.chop(1);
		request.setUrl(QUrl(base + "/chat/completions"));
		if (!key.isEmpty()) request.setRawHeader("Authorization", "Bearer " + key.toUtf8());
		QJsonArray msgs;
		msgs.append(QJsonObject{ { "role", "system" }, { "content", systemPrompt() } });
		for (const auto & v : m_messages) msgs.append(v);
		body["model"] = model;
		body["messages"] = msgs;
	}

	QNetworkReply * reply = m_network->post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
	connect(reply, &QNetworkReply::finished, this, [this, reply]() { handleReply(reply); });
}

void CopilotView::handleReply(QNetworkReply * reply) {
	reply->deleteLater();
	QByteArray data = reply->readAll();
	QJsonParseError parseError;
	QJsonDocument doc = QJsonDocument::fromJson(data, &parseError);
	QJsonObject obj = doc.object();

	if (reply->error() != QNetworkReply::NoError) {
		QString message = obj["error"].toObject()["message"].toString();
		if (message.isEmpty() && obj["error"].isString()) message = obj["error"].toString();
		if (message.isEmpty()) message = reply->errorString();
		setBusy(false);
		appendBubble(tr("Error"), message, "#c62828");
		return;
	}

	QString text;
	QString id = providerId();
	if (id == "gemini") {
		QJsonArray parts = obj["candidates"].toArray().first().toObject()["content"].toObject()["parts"].toArray();
		for (const auto & p : parts) text += p.toObject()["text"].toString();
	}
	else if (id == "anthropic") {
		for (const auto & c : obj["content"].toArray()) {
			if (c.toObject()["type"].toString() == "text") text += c.toObject()["text"].toString();
		}
	}
	else {
		text = obj["choices"].toArray().first().toObject()["message"].toObject()["content"].toString();
	}

	if (text.isEmpty()) {
		setBusy(false);
		appendBubble(tr("Error"), tr("The model returned an empty response."), "#c62828");
		return;
	}

	handleAssistantText(text);
}

QList<QJsonObject> CopilotView::extractActions(const QString & text, QString & visibleText) {
	QList<QJsonObject> actions;
	static const QRegularExpression block("```(?:actions|json)?\\s*(\\[[\\s\\S]*?\\]|\\{[\\s\\S]*?\\})\\s*```");
	visibleText = text;
	auto it = block.globalMatch(text);
	while (it.hasNext()) {
		auto match = it.next();
		QJsonDocument doc = QJsonDocument::fromJson(match.captured(1).toUtf8());
		bool found = false;
		if (doc.isArray()) {
			for (const auto & v : doc.array()) {
				if (v.isObject() && v.toObject().contains("action")) { actions.append(v.toObject()); found = true; }
			}
		}
		else if (doc.isObject() && doc.object().contains("action")) {
			actions.append(doc.object());
			found = true;
		}
		if (found) visibleText.remove(match.captured(0));
	}
	visibleText = visibleText.trimmed();
	return actions;
}

void CopilotView::handleAssistantText(const QString & text) {
	m_messages.append(QJsonObject{ { "role", "assistant" }, { "content", text } });

	QString visible;
	QList<QJsonObject> actions = extractActions(text, visible);
	if (!visible.isEmpty()) appendBubble(tr("Copilot"), visible, "#2e7d32");

	if (actions.isEmpty()) {
		setBusy(false);
		return;
	}

	if (++m_actionRounds > MaxActionRounds) {
		setBusy(false);
		appendBubble(tr("Copilot"), tr("Stopped after %1 rounds of actions. Send another message to continue.").arg(MaxActionRounds), "#ef6c00");
		return;
	}

	QJsonArray results;
	for (const auto & action : actions) {
		QJsonObject result;
		try {
			result = m_executor ? m_executor(action) : QJsonObject{ { "error", "no executor" } };
		}
		catch (...) {
			result = QJsonObject{ { "error", "action crashed" } };
		}
		QString summary = action["action"].toString();
		if (result.contains("error")) summary += "  ✗ " + result["error"].toString();
		else summary += "  ✓";
		m_transcript->append(QString("<p style='color:#757575; margin-left:12px'>&#9881; %1</p>").arg(summary.toHtmlEscaped()));
		results.append(QJsonObject{ { "action", action }, { "result", result } });
	}

	QString feedback = "Action results:\n" + QString::fromUtf8(QJsonDocument(results).toJson(QJsonDocument::Compact));
	m_messages.append(QJsonObject{ { "role", "user" }, { "content", feedback } });
	requestCompletion();
}
