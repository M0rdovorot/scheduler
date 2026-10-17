package reminder

import (
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Button is a button under a message.
type Button struct {
	Text string
	// Callback is what the bot gets back when the button is pressed.
	Callback string
	// OpenApp makes the button open the Mini App instead.
	OpenApp bool
}

// Message is what is sent to the user: plain text and rows of buttons.
type Message struct {
	Text    string
	Buttons [][]Button
}

// Actions behind the buttons.
const (
	ActionDone    = "done"    // a task: the fact equals the plan
	ActionNotDone = "notdone" // a task: not done
	ActionStart   = "start"   // a task: start the timer
	ActionStop    = "stop"    // a task: stop the timer
	ActionHabit   = "habit"   // a yes/no habit: done today
)

// Callback builds the data of a button, which Telegram limits to 64 bytes: "done:" + a uuid is 41.
func Callback(action string, id uuid.UUID) string { return action + ":" + id.String() }

// ParseCallback reads the data of a pressed button.
func ParseCallback(data string) (action string, id uuid.UUID, ok bool) {
	a, rest, found := strings.Cut(data, ":")
	if !found {
		return "", uuid.Nil, false
	}
	switch a {
	case ActionDone, ActionNotDone, ActionStart, ActionStop, ActionHabit:
	default:
		return "", uuid.Nil, false
	}
	id, err := uuid.Parse(rest)
	if err != nil {
		return "", uuid.Nil, false
	}
	return a, id, true
}

var (
	buttonOpen = Button{Text: "Открыть", OpenApp: true}
	buttonDone = func(id uuid.UUID) Button {
		return Button{Text: "Выполнено", Callback: Callback(ActionDone, id)}
	}
	buttonNotDone = func(id uuid.UUID) Button {
		return Button{Text: "Не выполнено", Callback: Callback(ActionNotDone, id)}
	}
)

func clock(t time.Time, loc *time.Location) string { return t.In(loc).Format("15:04") }

// minutesText is "10 мин", "1 ч", "1 ч 30 мин", "1 дн".
func minutesText(m int) string {
	switch {
	case m >= 1440 && m%1440 == 0:
		return fmt.Sprintf("%d дн", m/1440)
	case m >= 60 && m%60 == 0:
		return fmt.Sprintf("%d ч", m/60)
	case m >= 60:
		return fmt.Sprintf("%d ч %d мин", m/60, m%60)
	}
	return fmt.Sprintf("%d мин", m)
}

// TaskMessage is the message of a reminder about a task.
func TaskMessage(kind Kind, id uuid.UUID, title string, start, end, now time.Time, loc *time.Location) Message {
	switch kind {
	case BeforeStart:
		when := fmt.Sprintf("начнётся в %s", clock(start, loc))
		if !now.Before(start) {
			when = fmt.Sprintf("должно было начаться в %s", clock(start, loc))
		} else if d := int(start.Sub(now).Round(time.Minute) / time.Minute); d > 0 {
			when += fmt.Sprintf(" (через %s)", minutesText(d))
		}
		return Message{
			Text:    fmt.Sprintf("⏰ «%s» %s", title, when),
			Buttons: [][]Button{{{Text: "Старт", Callback: Callback(ActionStart, id)}, buttonOpen}},
		}
	case AfterEnd:
		return Message{
			Text:    fmt.Sprintf("«%s» закончилось в %s. Как прошло?", title, clock(end, loc)),
			Buttons: [][]Button{{buttonDone(id), buttonNotDone(id)}, {buttonOpen}},
		}
	case NotStarted:
		return Message{
			Text:    fmt.Sprintf("«%s» должно было начаться в %s, но не начато", title, clock(start, loc)),
			Buttons: [][]Button{{{Text: "Старт", Callback: Callback(ActionStart, id)}, buttonOpen}},
		}
	default: // Overrun
		return Message{
			Text:    fmt.Sprintf("«%s» затянулось: по плану оно закончилось в %s, а таймер идёт", title, clock(end, loc)),
			Buttons: [][]Button{{{Text: "Стоп", Callback: Callback(ActionStop, id)}, buttonOpen}},
		}
	}
}

// HabitMessage is the reminder about a habit. progress is empty for a yes/no habit.
func HabitMessage(id uuid.UUID, title string, boolean bool, progress string) Message {
	text := fmt.Sprintf("Привычка «%s»", title)
	if progress != "" {
		text += ": " + progress
	}
	row := []Button{buttonOpen}
	if boolean {
		row = []Button{{Text: "Выполнено", Callback: Callback(ActionHabit, id)}, buttonOpen}
	}
	return Message{Text: text, Buttons: [][]Button{row}}
}
