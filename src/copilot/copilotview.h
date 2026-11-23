/*******************************************************************

Part of the Fritzing project - http://fritzing.org

Fritzing is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

********************************************************************/

#ifndef COPILOTVIEW_H
#define COPILOTVIEW_H

#include <QFrame>
#include <QJsonArray>
#include <QJsonObject>
#include <functional>

class QComboBox;
class QLineEdit;
class QPlainTextEdit;
class QPushButton;
class QTextBrowser;
class QLabel;
class QNetworkAccessManager;
class QNetworkReply;

// Chat tab that talks to OpenAI, Gemini, Claude or any OpenAI-compatible
// endpoint, and lets the model drive Fritzing through a small action set.
class CopilotView : public QFrame
{
	Q_OBJECT

public:
	// Runs one action requested by the model and returns a JSON result.
	using ActionExecutor = std::function<QJsonObject(const QJsonObject &)>;

	explicit CopilotView(ActionExecutor executor, QWidget * parent = nullptr);

protected Q_SLOTS:
	void sendClicked();
	void providerChanged(int index);
	void clearChat();
	void saveSettings();

protected:
	void requestCompletion();
	void handleReply(QNetworkReply * reply);
	void handleAssistantText(const QString & text);
	QList<QJsonObject> extractActions(const QString & text, QString & visibleText);
	void appendBubble(const QString & who, const QString & text, const QString & color);
	void setBusy(bool busy);
	QString systemPrompt() const;
	QString providerId() const;
	void loadSettings();

protected:
	ActionExecutor m_executor;
	QNetworkAccessManager * m_network = nullptr;

	QComboBox * m_provider = nullptr;
	QComboBox * m_model = nullptr;
	QLineEdit * m_apiKey = nullptr;
	QLineEdit * m_baseUrl = nullptr;
	QLabel * m_baseUrlLabel = nullptr;
	QTextBrowser * m_transcript = nullptr;
	QPlainTextEdit * m_input = nullptr;
	QPushButton * m_send = nullptr;
	QLabel * m_status = nullptr;

	// Conversation as {role: user|assistant, content: text}
	QJsonArray m_messages;
	int m_actionRounds = 0;
	bool m_busy = false;
};

#endif
