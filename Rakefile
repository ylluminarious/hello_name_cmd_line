require "opal"

task :build do
    environment = Opal::Environment.new
    environment.append_path "rb"
 
    File.open("compiled.js", "w+") do |output|
        output << environment["main"].to_s
    end
end