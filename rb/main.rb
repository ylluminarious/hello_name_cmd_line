require "opal"
require "opal/browser"

prompt_for_name = Proc.new do
    name = $$.prompt("What's your name?")
    unless name == "" || name == nil
        $$.alert("Hi, #{name}!")
    else
        $$.alert("That's not a valid name.")
    end
end


logo = $$[:document].getElementById("logo")
logo.onclick = prompt_for_name